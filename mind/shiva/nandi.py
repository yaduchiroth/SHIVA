"""Nandi — the watcher at the gate.

Face recognition from the Mac camera using OpenCV's YuNet (detection) and
SFace (embeddings). Chosen deliberately over dlib/InsightFace: a single
`opencv-python` wheel installs cleanly on Apple Silicon, and the two small
ONNX models download automatically on first run.

All biometric data (embeddings) stays in data/nandi.json on this Mac —
nothing ever leaves the machine. That line is also the client pitch.
"""
import asyncio
import base64
import json
import time

import numpy as np

# Git-LFS media URLs (the plain /raw/ URLs return LFS pointers, not bytes)
MODEL_URLS = {
    "yunet.onnx": ("https://media.githubusercontent.com/media/opencv/opencv_zoo/"
                   "main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"),
    "sface.onnx": ("https://media.githubusercontent.com/media/opencv/opencv_zoo/"
                   "main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx"),
}


class Nandi:
    def __init__(self, cfg, bus, on_known, on_guest=None, on_seen=None,
                 is_speaking=None, on_barge_in=None) -> None:
        self.cfg = cfg
        self.bus = bus
        self.on_known = on_known    # async fn(name) — greeting, absence-gated
        self.on_guest = on_guest    # async fn() or None
        self.on_seen = on_seen      # plain fn(name) — every recognition, ungated
        self.is_speaking = is_speaking   # plain fn() -> bool: SHIVA is talking now
        self.on_barge_in = on_barge_in   # async fn(): wave-to-stop was detected
        self.last_seen: dict[str, float] = {}
        self.guest_last = 0.0
        self.db: dict[str, np.ndarray] = {}
        self._stop = False
        self._last_seen_log = 0.0
        self.latest_frame = None    # most recent BGR frame — for the `look` tool
        self._prev_gray = None      # previous grayscale frame — for motion barge-in
        self._last_wave = 0.0

    # Shared helpers (also used by shiva.enroll) ----------------------------
    @staticmethod
    def ensure_models(cfg):
        import httpx

        mdir = cfg.data_dir / "models"
        mdir.mkdir(parents=True, exist_ok=True)
        for name, url in MODEL_URLS.items():
            path = mdir / name
            if not path.exists():
                print(f"[nandi] downloading {name}…")
                r = httpx.get(url, follow_redirects=True, timeout=180)
                r.raise_for_status()
                path.write_bytes(r.content)
        return mdir / "yunet.onnx", mdir / "sface.onnx"

    @staticmethod
    def build_engines(cfg):
        import cv2

        det_path, rec_path = Nandi.ensure_models(cfg)
        detector = cv2.FaceDetectorYN_create(str(det_path), "", (640, 480),
                                             0.8, 0.3, 5000)
        recognizer = cv2.FaceRecognizerSF_create(str(rec_path), "")
        return detector, recognizer

    @staticmethod
    def largest_face(faces):
        if faces is None or len(faces) == 0:
            return None
        return max(faces, key=lambda f: float(f[2]) * float(f[3]))

    def _load_db(self) -> None:
        path = self.cfg.data_dir / "nandi.json"
        if path.exists():
            raw = json.loads(path.read_text())
            self.db = {k: np.asarray(v, dtype=np.float32) for k, v in raw.items()}

    # Main loop ------------------------------------------------------------
    async def run(self) -> None:
        if not self.cfg.nandi_enabled:
            return
        try:
            import cv2  # noqa: F401
        except Exception as e:
            await self.bus.log(f"nandi disabled (opencv: {e})")
            return
        self._load_db()
        if not self.db:
            await self.bus.log(
                'nandi idle — enroll a face first: python -m shiva.enroll --name "Boss"')
            return
        loop = asyncio.get_running_loop()
        await self.bus.log(f"nandi watching for: {', '.join(self.db)}")
        await loop.run_in_executor(None, self._watch, loop)

    def _watch(self, loop) -> None:
        import cv2

        detector, recognizer = self.build_engines(self.cfg)
        cap = cv2.VideoCapture(self.cfg.camera_index)
        if not cap.isOpened():
            asyncio.run_coroutine_threadsafe(
                self.bus.log("nandi: camera unavailable (check permissions)"), loop)
            return
        # modest capture size keeps detection + encoding fast at full frame rate
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 640
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 480
        detector.setInputSize((w, h))

        frame_i = 0
        results: list = []  # [(face_box, name)] — names cached between recognitions
        while not self._stop:
            ok, frame = cap.read()  # blocks at camera rate (~30 fps)
            if not ok:
                time.sleep(1.0)
                continue
            self.latest_frame = frame  # kept fresh for the `look` tool
            self._check_wave(frame, loop)
            hud_open = bool(self.bus.clients)
            frame_i += 1
            try:
                _, faces = detector.detect(frame)
            except Exception:
                faces = None
            if faces is None:
                results = []
            elif frame_i % 6 == 0 or len(faces) != len(results):
                # full recognition ~5×/s (or when faces appear/leave)
                results = []
                for face in faces:
                    name, score = self._identify(recognizer, frame, face)
                    results.append((face, name))
                    self._register(name, score, loop)
            else:
                # between recognitions: fresh boxes, cached names
                results = [(face, results[i][1] if i < len(results) else None)
                           for i, face in enumerate(faces)]
            if hud_open:
                self._emit_frame(frame, results, loop)
            else:
                time.sleep(self.cfg.nandi_interval)  # nobody watching — save CPU
        cap.release()

    def _check_wave(self, frame, loop) -> None:
        """Wave-to-stop: while SHIVA speaks, a hand swept across the lens changes a
        big fraction of the frame at once — cut him off the instant that happens."""
        import cv2

        try:
            small = cv2.resize(frame, (160, 120))
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        except Exception:
            return
        prev, self._prev_gray = self._prev_gray, gray
        if prev is None or not (self.is_speaking and self.on_barge_in):
            return
        if not self.is_speaking():
            return
        now = time.time()
        if now - self._last_wave < self.cfg.nandi_wave_cooldown:
            return
        diff = cv2.absdiff(gray, prev)
        changed = float(np.count_nonzero(diff > 25)) / diff.size
        if changed >= self.cfg.nandi_wave_ratio:
            self._last_wave = now
            asyncio.run_coroutine_threadsafe(
                self.bus.log(f"nandi: wave detected ({changed:.0%}) — stopping"), loop)
            asyncio.run_coroutine_threadsafe(self.on_barge_in(), loop)

    def _identify(self, recognizer, frame, face):
        try:
            feat = recognizer.feature(recognizer.alignCrop(frame, face))
            return self._match(recognizer, feat)
        except Exception:
            return None, 0.0

    def _register(self, name, score, loop) -> None:
        """Every recognition: update the brain; greet only after an absence."""
        now = time.time()
        if name:
            if self.on_seen:
                self.on_seen(name)
            if now - self._last_seen_log > 10:
                self._last_seen_log = now
                asyncio.run_coroutine_threadsafe(
                    self.bus.log(f"nandi: {name} in sight (match {score:.2f})"), loop)
            prev = self.last_seen.get(name, 0.0)
            self.last_seen[name] = now
            if now - prev > self.cfg.nandi_absence:
                asyncio.run_coroutine_threadsafe(self.on_known(name), loop)
        else:
            prev = self.guest_last
            self.guest_last = now
            if now - prev > self.cfg.nandi_absence and self.on_guest:
                asyncio.run_coroutine_threadsafe(self.on_guest(), loop)

    def _emit_frame(self, frame, results, loop) -> None:
        """Ship an annotated camera frame to the HUD (only while a HUD is open)."""
        import cv2

        if not self.bus.clients:
            return
        names = []
        view = frame.copy()
        for face, name in results:
            x, y, w, h = (int(v) for v in face[:4])
            color = (39, 162, 201) if name else (120, 100, 91)  # BGR gold / grey
            cv2.rectangle(view, (x, y), (x + w, y + h), color, 2)
            cv2.putText(view, (name or "unknown").upper(), (x, max(18, y - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 1, cv2.LINE_AA)
            if name:
                names.append(name)
        scale = 320 / view.shape[1]
        view = cv2.resize(view, (320, int(view.shape[0] * scale)))
        ok, jpg = cv2.imencode(".jpg", view, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            asyncio.run_coroutine_threadsafe(
                self.bus.emit("camera", jpg=base64.b64encode(jpg.tobytes()).decode(),
                              names=names), loop)

    def _match(self, recognizer, feat):
        import cv2

        best_name, best_score = None, 0.0
        for name, embs in self.db.items():
            for emb in np.atleast_2d(embs):
                score = recognizer.match(feat, emb.reshape(1, -1),
                                         cv2.FaceRecognizerSF_FR_COSINE)
                if score > best_score:
                    best_name, best_score = name, score
        if best_score >= self.cfg.nandi_threshold:
            return best_name, best_score
        return None, best_score

    def stop(self) -> None:
        self._stop = True
