"""Vani — SHIVA's ear for *who* is speaking.

Speaker recognition via Resemblyzer d-vectors (GE2E). Each person gets a small
voiceprint — a handful of 256-d unit vectors — stored in data/vani.json.
Nothing but the math ever leaves this Mac, the same promise Nandi makes for
faces.

Degrades silently: if resemblyzer/torch can't be imported, `ready` stays False
and identify() returns (None, 0.0), so SHIVA behaves exactly as before.
"""
import json
import threading

import numpy as np

_ENCODER = None
_ENCODER_LOCK = threading.Lock()


def _get_encoder():
    global _ENCODER
    if _ENCODER is None:
        with _ENCODER_LOCK:
            if _ENCODER is None:
                from resemblyzer import VoiceEncoder
                _ENCODER = VoiceEncoder("cpu", verbose=False)
    return _ENCODER


class Vani:
    def __init__(self, cfg) -> None:
        self.cfg = cfg
        self.path = cfg.data_dir / "vani.json"
        self.db: dict[str, np.ndarray] = {}   # name -> (N, 256) unit vectors
        self.ready = False
        self._lock = threading.Lock()
        self._load()

    # persistence ----------------------------------------------------------
    def _load(self) -> None:
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text())
                self.db = {k: np.asarray(v, dtype=np.float32).reshape(-1, 256)
                           for k, v in raw.items()}
            except Exception:
                self.db = {}

    def _save(self) -> None:
        self.path.write_text(json.dumps({k: v.tolist() for k, v in self.db.items()}))

    # lifecycle ------------------------------------------------------------
    def warm(self) -> bool:
        """Import resemblyzer + load the encoder. Call from a worker thread."""
        try:
            _get_encoder()
            self.ready = True
        except Exception as e:  # torch/resemblyzer missing → feature just off
            print(f"[vani] speaker recognition unavailable: {e}")
            self.ready = False
        return self.ready

    # core -----------------------------------------------------------------
    def embed(self, audio):
        """audio: float32 mono @16k in [-1, 1]  ->  256-d unit vector (or None)."""
        try:
            from resemblyzer import preprocess_wav

            enc = _get_encoder()
            wav = preprocess_wav(np.asarray(audio, dtype=np.float32), source_sr=16000)
            if wav.size < 16000 * 0.5:   # <0.5 s of usable voiced audio — too thin
                return None
            return enc.embed_utterance(wav).astype(np.float32)
        except Exception:
            return None

    def identify(self, audio):
        """-> (name|None, score). Cosine of unit d-vectors; same speaker ~0.8+."""
        if not self.db:
            return None, 0.0
        emb = self.embed(audio)
        if emb is None:
            return None, 0.0
        best_name, best = None, -1.0
        for name, samples in self.db.items():
            score = float(np.max(samples @ emb))   # samples are unit vectors
            if score > best:
                best_name, best = name, score
        if best >= self.cfg.bragi_threshold:
            return best_name, best
        return None, best

    def enroll(self, name, audio, cap=8) -> bool:
        """Add one voiceprint sample for `name` (keeps the newest `cap`)."""
        emb = self.embed(audio)
        if emb is None:
            return False
        with self._lock:
            cur = self.db.get(name)
            stack = emb.reshape(1, -1) if cur is None else np.vstack([cur, emb.reshape(1, -1)])
            self.db[name] = stack[-cap:]
            self._save()
        return True

    def has(self, name) -> bool:
        return name in self.db and len(self.db[name]) > 0
