"""Sentinel — SHIVA's sleeping ear.

While SHIVA stands by, this is the ONLY thing listening: a pure signal-
processing loop watching for a DOUBLE CLAP (two sharp transients 80–600 ms
apart). Nothing is transcribed and nothing leaves the machine; audio frames
are discarded as they age. Only after a clap-pair does it record a short
snippet (~2.5 s) and run local Whisper on just that, looking for a keyword:

    asleep  + "wake up"   -> on_wake()
    awake   + "shutdown"  -> on_sleep()   (clap-pair required, so the word
                                           alone in conversation never fires)

While SHIVA is awake the full Ears pipeline owns the mic; Sentinel then only
watches the same frame stream for clap-pairs (Ears feeds it) to arm the
shutdown phrase.
"""
import asyncio
import collections
import queue
import time

import numpy as np

SAMPLE_RATE = 16000
FRAME_MS = 30
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000

CLAP_RMS = 0.25            # transient loudness floor (int16 scale ~8200)
CLAP_RATIO = 6.0           # spike vs recent background
CLAP_GAP_MIN = 0.08        # seconds between the two claps
CLAP_GAP_MAX = 0.65
SNIPPET_SECONDS = 2.6      # keyword window after a clap-pair

WAKE_WORDS = ("wake up", "wakeup", "wake-up", "rise")
SLEEP_WORDS = ("shutdown", "shut down", "go to sleep", "stand down")


class ClapDetector:
    """Feed it 30 ms int16 frames; it reports when a clap-pair lands."""

    def __init__(self) -> None:
        self._bg = collections.deque(maxlen=33)  # ~1 s of background RMS
        self._last_clap = 0.0
        self._pair_at = 0.0

    def feed(self, frame: bytes) -> bool:
        """-> True exactly once per detected clap-pair."""
        a = np.frombuffer(frame, np.int16).astype(np.float32) / 32768.0
        rms = float(np.sqrt((a * a).mean()))
        bg = (sum(self._bg) / len(self._bg)) if self._bg else 0.0
        self._bg.append(rms)
        now = time.time()
        is_clap = rms > CLAP_RMS and (bg < 1e-4 or rms / max(bg, 1e-4) > CLAP_RATIO)
        if not is_clap:
            return False
        gap = now - self._last_clap
        self._last_clap = now
        if CLAP_GAP_MIN <= gap <= CLAP_GAP_MAX and now - self._pair_at > 2.0:
            self._pair_at = now
            return True
        return False

    def pair_recent(self, within: float = 3.0) -> bool:
        return time.time() - self._pair_at <= within


class Sentinel:
    """Standby listener: owns the mic ONLY while SHIVA sleeps."""

    def __init__(self, cfg, bus) -> None:
        self.cfg = cfg
        self.bus = bus
        self._stop = False

    def stop(self) -> None:
        self._stop = True

    async def run_asleep(self) -> bool:
        """Blocking sentinel loop for the sleep state. Returns True when the
        wake ritual should fire (mic already released), False if stopped."""
        try:
            import sounddevice as sd
        except Exception as e:
            await self.bus.log(f"sentinel: audio unavailable ({e}) — type 'wake' instead")
            return False
        loop = asyncio.get_running_loop()
        frames: queue.Queue = queue.Queue()

        def cb(indata, n, t, status):
            frames.put(bytes(indata))

        det = ClapDetector()
        stream = sd.RawInputStream(samplerate=SAMPLE_RATE, blocksize=FRAME_SAMPLES,
                                   dtype="int16", channels=1, callback=cb)
        stream.start()
        await self.bus.log("sentinel on watch — clap twice and say “wake up”")
        try:
            while not self._stop:
                try:
                    frame = await loop.run_in_executor(None, frames.get, True, 0.5)
                except Exception:
                    continue
                if not det.feed(frame):
                    continue
                # clap-pair heard: record a short snippet and check the word
                await self.bus.log("sentinel: clap-pair — listening for the word")
                snippet = bytearray()
                deadline = time.time() + SNIPPET_SECONDS
                while time.time() < deadline:
                    try:
                        snippet += frames.get(timeout=0.5)
                    except queue.Empty:
                        continue
                text = await loop.run_in_executor(None, self._transcribe, bytes(snippet))
                if text:
                    await self.bus.log(f"sentinel heard: {text!r}")
                if text and any(w in text for w in WAKE_WORDS):
                    return True
        finally:
            stream.stop()
            stream.close()
        return False

    def _transcribe(self, pcm: bytes) -> str:
        try:
            import mlx_whisper

            a = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
            r = mlx_whisper.transcribe(a, path_or_hf_repo=self.cfg.whisper_model)
            return (r.get("text") or "").strip().lower()
        except Exception:
            return ""


def is_sleep_phrase(text: str) -> bool:
    t = text.lower()
    return any(w in t for w in SLEEP_WORDS)
