"""SHIVA's ears — wake word ("Hey SHIVA" / built-in fallback), VAD-endpointed
recording, and on-device Whisper transcription (MLX, Apple Silicon).

Degrades gracefully: no Picovoice key → push-to-talk (Enter key in terminal);
no mic/whisper → typed text mode still works via __main__.
"""
import asyncio
import queue
import threading
import time

SAMPLE_RATE = 16000
VAD_FRAME_MS = 30
VAD_FRAME_SAMPLES = SAMPLE_RATE * VAD_FRAME_MS // 1000  # 480
SILENCE_END_FRAMES = 7    # ~210 ms of trailing silence ends the utterance (snappier)
MAX_UTTERANCE_SECONDS = 20
MIN_UTTERANCE_SECONDS = 0.4
VOICE_START_TIMEOUT = 5   # give up if no speech begins within this many seconds
MIN_VOICED_FRAMES = 17    # ~500 ms of actual speech, else it's noise, not words
MIN_UTTERANCE_RMS = 250   # average energy floor across voiced audio (int16)


class Ears:
    def __init__(self, cfg, bus, on_utterance, hot=None, vani=None,
                 identity_hint=None, is_speaking=None, clap_feed=None) -> None:
        self.cfg = cfg
        self.bus = bus
        self.on_utterance = on_utterance  # async fn(text, speaker)
        self.hot = hot  # plain fn() -> bool: open the mic without any trigger
        self.vani = vani  # Vani | None — speaker recognition
        self.identity_hint = identity_hint  # plain fn() -> name|None (verified face)
        self.is_speaking = is_speaking  # plain fn() -> bool: SHIVA is talking now
        self.clap_feed = clap_feed  # plain fn(frame_bytes) — sentinel clap detector
        self.need_speaker = None    # plain fn() -> bool: skip Vani when False
        self._frames: queue.Queue = queue.Queue()
        self._ptt = threading.Event()  # push-to-talk trigger (thread-safe)
        self._whisper_ready = False
        self._stop = False

    def stop(self) -> None:
        """Release the mic — SHIVA is going to sleep. The run() task winds down."""
        self._stop = True
        self._ptt.set()  # unblock any wait

    def trigger(self) -> None:
        """Push-to-talk: Enter key, or Nandi after a greeting.

        Works in BOTH modes — with a wake word active it simply opens the mic
        immediately, so the user can answer a greeting without saying it.
        """
        self._ptt.set()

    # ----------------------------------------------------------------------
    async def run(self) -> None:
        try:
            import numpy as np  # noqa: F401
            import sounddevice as sd
        except Exception as e:
            await self.bus.log(f"audio unavailable ({e}) — text mode only")
            return

        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._warm_whisper)
        if self.vani:
            ok = await loop.run_in_executor(None, self.vani.warm)
            await self.bus.log(f"vani {'online — speaker recognition' if ok else 'offline'}")

        porcupine = self._make_porcupine()
        blocksize = porcupine.frame_length if porcupine else VAD_FRAME_SAMPLES

        def callback(indata, frames, t, status):
            b = bytes(indata)
            self._frames.put(b)
            if self.clap_feed:
                try:
                    self.clap_feed(b)   # sentinel clap detector (awake mode)
                except Exception:
                    pass

        stream = sd.RawInputStream(
            samplerate=SAMPLE_RATE, blocksize=blocksize, dtype="int16",
            channels=1, callback=callback,
        )
        stream.start()
        mode = "wake word" if porcupine else "push-to-talk (press Enter)"
        await self.bus.log(f"ears online — {mode}")

        try:
            while not self._stop:
                if porcupine:
                    woke = await loop.run_in_executor(None, self._wait_for_wake, porcupine)
                else:
                    woke = await loop.run_in_executor(None, self._wait_for_trigger)
                if self._stop:
                    break
                if not woke:
                    continue
                text, audio = await self._capture_and_transcribe(loop)
                if text and not self._sane_transcript(text):
                    await self.bus.log("ears: dropped garbled transcript (noise)")
                    await self.bus.state("idle")
                    text = None
                if text:
                    if self.need_speaker is None or self.need_speaker():
                        speaker = await self._identify_speaker(loop, audio)
                    else:
                        speaker = None   # verified session + face in sight — save the work
                    await self.bus.transcript("user", text)
                    await self.on_utterance(text, speaker)
        finally:
            stream.stop()
            stream.close()
            if porcupine:
                porcupine.delete()

    # ----------------------------------------------------------------------
    def _make_porcupine(self):
        if not self.cfg.picovoice_key:
            return None
        try:
            import pvporcupine

            if self.cfg.wake_keyword_path:
                return pvporcupine.create(
                    access_key=self.cfg.picovoice_key,
                    keyword_paths=[self.cfg.wake_keyword_path],
                )
            return pvporcupine.create(
                access_key=self.cfg.picovoice_key, keywords=[self.cfg.wake_builtin]
            )
        except Exception as e:
            print(f"[shiva] wake word disabled: {e}")
            return None

    def _wait_for_trigger(self) -> bool:
        """Blocking: Enter (push-to-talk) — or the mic stays hot while a
        verified face is in sight (completely hands-free)."""
        while not self._stop:
            if self._ptt.wait(timeout=0.4):
                self._ptt.clear()
                return not self._stop
            if self.hot and self.hot():
                return True
        return False

    def _wait_for_wake(self, porcupine) -> bool:
        """Blocking: consume frames until the wake word is heard (or push-to-talk)."""
        import struct

        buf = b""
        frame_bytes = porcupine.frame_length * 2
        while True:
            if self._ptt.is_set():  # greeting/Enter opens the mic instantly
                self._ptt.clear()
                return True
            if self.hot and self.hot():  # presence keeps the mic hot too
                return True
            try:
                buf += self._frames.get(timeout=0.5)
            except queue.Empty:
                continue
            while len(buf) >= frame_bytes:
                chunk, buf = buf[:frame_bytes], buf[frame_bytes:]
                pcm = struct.unpack_from(f"{porcupine.frame_length}h", chunk)
                if porcupine.process(pcm) >= 0:
                    return True

    async def _capture_and_transcribe(self, loop):
        await self.bus.state("listening")
        audio = await loop.run_in_executor(None, self._record_utterance)
        if audio is None:
            await self.bus.state("idle")
            return None, None
        await self.bus.state("thinking")
        t0 = time.time()
        text = await loop.run_in_executor(None, self._transcribe, audio)
        if text:
            await self.bus.log(f"⏱ stt {time.time() - t0:.2f}s")
        return text, audio

    async def _identify_speaker(self, loop, audio):
        """Return a speaker label for this utterance: a known name, the string
        'an unrecognized speaker', or None when the feature isn't active.

        Auto-learns while a verified face is in sight — the face proves who it
        is, so we quietly memorize (or reinforce) that person's voiceprint.
        """
        if not (self.vani and self.vani.ready) or audio is None:
            return None
        hinted = self.identity_hint() if self.identity_hint else None

        def work():
            has_prints = bool(self.vani.db)
            learnable = self.cfg.bragi_autolearn and hinted and "guest" not in hinted
            if not has_prints and not learnable:
                return None  # nothing enrolled and nothing we're allowed to learn
            name, _score = self.vani.identify(audio)
            if learnable and (not self.vani.has(hinted) or name == hinted):
                # face-verified: bootstrap or reinforce this person's voiceprint
                self.vani.enroll(hinted, audio)
                return hinted
            if name:
                return name
            return "an unrecognized speaker" if self.vani.db else None

        try:
            return await loop.run_in_executor(None, work)
        except Exception:
            return None

    def _record_utterance(self):
        """Blocking: record until trailing silence (VAD, RMS fallback)."""
        import numpy as np

        try:
            import webrtcvad

            vad = webrtcvad.Vad(2)
        except Exception:
            vad = None

        # flush stale frames
        while not self._frames.empty():
            try:
                self._frames.get_nowait()
            except queue.Empty:
                break

        collected = b""
        voiced = b""      # only the frames VAD called speech — used for the energy gate
        buf = b""
        silent = 0
        voiced_frames = 0
        start = time.time()
        frame_bytes = VAD_FRAME_SAMPLES * 2

        while time.time() - start < MAX_UTTERANCE_SECONDS:
            # Echo guard: if SHIVA is speaking, any audio the mic hears is his own
            # TTS (no hardware echo cancellation). Discard the capture rather than
            # transcribe ourselves and reply to it. Barge-in stays handled by
            # Nandi's camera watcher, which cuts playback on movement.
            if self.is_speaking and self.is_speaking():
                return None
            if not voiced_frames and time.time() - start > VOICE_START_TIMEOUT:
                return None  # nobody spoke — close the mic instead of hanging open
            try:
                buf += self._frames.get(timeout=1.0)
            except queue.Empty:
                continue
            while len(buf) >= frame_bytes:
                frame, buf = buf[:frame_bytes], buf[frame_bytes:]
                collected += frame
                if vad is not None:
                    is_speech = vad.is_speech(frame, SAMPLE_RATE)
                else:
                    rms = np.sqrt(np.mean(np.frombuffer(frame, np.int16).astype(np.float32) ** 2))
                    is_speech = rms > 350
                if is_speech:
                    voiced_frames += 1
                    voiced += frame
                    silent = 0
                else:
                    silent += 1
            if voiced_frames and silent >= SILENCE_END_FRAMES:
                break

        duration = len(collected) / 2 / SAMPLE_RATE
        # Guard against Whisper hallucinating words out of near-silence: demand a
        # real chunk of voiced speech AND enough energy in it, not one stray blip.
        if voiced_frames < MIN_VOICED_FRAMES or duration < MIN_UTTERANCE_SECONDS:
            return None
        voiced_rms = np.sqrt(np.mean(np.frombuffer(voiced, np.int16).astype(np.float32) ** 2))
        if voiced_rms < MIN_UTTERANCE_RMS:
            return None
        return np.frombuffer(collected, np.int16).astype(np.float32) / 32768.0

    # Whisper's stock hallucinations on silence / room noise. When the whole
    # utterance is nothing but one of these, it's phantom audio, not speech.
    _PHANTOMS = {
        "you", "thank you", "thank you.", "you.", "thanks for watching",
        "thanks for watching!", "thank you for watching", "bye", "bye.",
        ".", "so", "so.", "the", "i", "yeah", "okay", "ok", "uh", "um",
        "please subscribe", "subscribe",
    }

    @classmethod
    def _sane_transcript(cls, text: str) -> bool:
        """Reject Whisper's noise hallucinations: a stock phantom phrase, one
        token repeated endlessly, or a short phrase looped (classic phantom)."""
        stripped = text.lower().strip().strip(".,!?…- ")
        if stripped in cls._PHANTOMS or text.lower().strip() in cls._PHANTOMS:
            return False
        # a single space-free glyph hammered out (e.g. CJK/Sinhala hallucinations
        # from near-silence) — no word-splitting will catch this, so check
        # character-level repetition directly.
        compact = stripped.replace(" ", "")
        if len(compact) >= 12:
            from collections import Counter
            top = Counter(compact).most_common(1)[0][1]
            if top / len(compact) > 0.5:
                return False
        # normalize: lowercase, drop per-word punctuation so "work." == "work"
        words = [w.strip(".,!?…-'\"") for w in text.lower().split()]
        words = [w for w in words if w]
        if not words:
            return False
        # a single token repeated (e.g. "no no no no ...")
        if len(words) >= 10 and len(set(words)) <= max(2, len(words) // 10):
            return False
        # a short phrase looped: very low vocabulary diversity over enough words
        if len(words) >= 8 and len(set(words)) / len(words) <= 0.45:
            return False
        return True

    def _warm_whisper(self) -> None:
        try:
            import mlx_whisper  # noqa: F401

            self._whisper_ready = True
        except Exception as e:
            print(f"[shiva] whisper unavailable: {e}")

    def _transcribe(self, audio):
        if not self._whisper_ready:
            return None
        import mlx_whisper

        result = mlx_whisper.transcribe(audio, path_or_hf_repo=self.cfg.whisper_model)
        text = (result.get("text") or "").strip()
        return text or None
