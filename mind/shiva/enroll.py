"""Enroll a face for Nandi.

    python -m shiva.enroll --name "Boss"                # from the Mac camera
    python -m shiva.enroll --name "Boss" --photos DIR   # from a folder of photos

Camera mode captures N samples while you slowly turn your head — do it in
the same lighting you'll demo in. Embeddings (not images) are stored in
data/nandi.json and never leave this Mac.
"""
import argparse
import json
import time


def enroll_voice(args) -> None:
    """Record a few seconds of speech and store a Vani voiceprint."""
    import numpy as np
    import sounddevice as sd

    from .config import Config
    from .vani import Vani

    cfg = Config()
    vani = Vani(cfg)
    if not vani.warm():
        raise SystemExit("Speaker recognition unavailable — is resemblyzer installed?")
    secs = args.seconds
    print(f"Speak naturally for about {secs} seconds — say anything…")
    audio = sd.rec(int(secs * 16000), samplerate=16000, channels=1, dtype="float32")
    sd.wait()
    if not vani.enroll(args.name, audio.flatten()):
        raise SystemExit("No usable voice captured — try again somewhere quiet.")
    print(f"Saved a voiceprint for '{args.name}'. SHIVA will recognize the voice now "
          f"({len(vani.db[args.name])} sample(s) total).")


def main() -> None:
    ap = argparse.ArgumentParser(prog="shiva.enroll")
    ap.add_argument("--name", required=True, help='e.g. "Boss"')
    ap.add_argument("--photos", help="folder of jpg/png photos instead of camera")
    ap.add_argument("--samples", type=int, default=12, help="camera samples (default 12)")
    ap.add_argument("--voice", action="store_true",
                    help="enroll a VOICEPRINT (Vani) from the mic instead of a face")
    ap.add_argument("--seconds", type=int, default=6, help="voice recording length")
    args = ap.parse_args()

    if args.voice:
        enroll_voice(args)
        return

    import cv2
    import numpy as np

    from .config import Config
    from .nandi import Nandi

    cfg = Config()
    detector, recognizer = Nandi.build_engines(cfg)
    feats: list[list[float]] = []

    def embed(frame):
        h, w = frame.shape[:2]
        detector.setInputSize((w, h))
        _, faces = detector.detect(frame)
        face = Nandi.largest_face(faces)
        if face is None:
            return None
        aligned = recognizer.alignCrop(frame, face)
        return recognizer.feature(aligned).flatten().tolist()

    if args.photos:
        from pathlib import Path

        files = [p for p in Path(args.photos).iterdir()
                 if p.suffix.lower() in (".jpg", ".jpeg", ".png")]
        for p in files:
            img = cv2.imread(str(p))
            if img is None:
                continue
            f = embed(img)
            if f:
                feats.append(f)
                print(f"  ✓ {p.name}")
            else:
                print(f"  ✗ {p.name} (no face found)")
    else:
        cap = cv2.VideoCapture(cfg.camera_index)
        if not cap.isOpened():
            raise SystemExit("Camera unavailable — grant camera permission to your terminal.")
        print(f"Look at the camera. Capturing {args.samples} samples — "
              "turn your head slowly, vary your expression…")
        while len(feats) < args.samples:
            ok, frame = cap.read()
            if not ok:
                time.sleep(0.2)
                continue
            f = embed(frame)
            if f:
                feats.append(f)
                print(f"  captured {len(feats)}/{args.samples}")
                time.sleep(0.45)
        cap.release()

    if not feats:
        raise SystemExit("No faces captured — nothing saved.")

    path = cfg.data_dir / "nandi.json"
    db = json.loads(path.read_text()) if path.exists() else {}
    db.setdefault(args.name, [])
    db[args.name].extend(feats)
    path.write_text(json.dumps(db))
    print(f"\nSaved {len(feats)} embeddings for '{args.name}' "
          f"({len(db[args.name])} total). Nandi will greet them on sight.")

    # quick self-check: embeddings of the same person should agree
    arr = np.asarray(db[args.name], dtype=np.float32)
    if len(arr) >= 2:
        s = recognizer.match(arr[0].reshape(1, -1), arr[-1].reshape(1, -1),
                             cv2.FaceRecognizerSF_FR_COSINE)
        print(f"Self-consistency score: {s:.3f} "
              f"({'good' if s >= 0.363 else 'LOW — re-enroll in better lighting'})")


if __name__ == "__main__":
    main()
