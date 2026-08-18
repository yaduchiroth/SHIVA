"""SHIVA's voice — TTS engines, played through the HUD for avatar lip-sync.

Engine order: ElevenLabs (if key set) → Kokoro (local neural, SHIVA_TTS=kokoro)
→ macOS `say` (always available; SHIVA never goes mute).

Audio routing for the byte-producing engines (ElevenLabs mp3 / Kokoro wav):
1. HUD open + HUD_AUDIO=1 → audio is sent to the browser over WebSocket; the
   HUD plays it via WebAudio and drives the avatar's mouth from the live
   waveform, then reports back "audio_done".
2. No HUD → ffplay plays it locally.
"""
import asyncio
import base64
import contextlib
import io
import re
import time
import wave
from collections import deque

SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")


class Voice:
    def __init__(self, cfg, bus) -> None:
        self.cfg = cfg
        self.bus = bus
        self.queue: asyncio.Queue = asyncio.Queue()
        self._speaking = asyncio.Event()
        self._hud_done = asyncio.Event()
        self._interrupt = asyncio.Event()      # set by stop() — barge-in
        self._current_proc = None              # live ffplay/say process, if any
        self._macos_voice: str | None = None  # resolved on first use
        self._kokoro = None                    # lazy-loaded local TTS model
        self._kokoro_failed = False            # tried and unusable — stop retrying
        # Content-based echo backstop: what SHIVA recently spoke, so the ears can
        # drop a transcript that is really SHIVA's own voice looping back in.
        self._spoken_log: deque = deque(maxlen=12)  # (time, word-set)

    async def run(self) -> None:
        """Consume the speech queue sequentially."""
        while True:
            text = await self.queue.get()
            self._interrupt.clear()
            self._speaking.set()
            await self.bus.state("speaking")
            try:
                await self._speak(text)
            except Exception as e:  # never let TTS kill the loop
                await self.bus.log(f"tts error: {e}")
                if not self._interrupt.is_set():
                    await self._speak_macos(text)
            finally:
                self._speaking.clear()
                if self.queue.empty():
                    await self.bus.state("idle")

    async def say(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        await self.bus.transcript("shiva", text)
        words = self._normalize(text)
        if words:
            self._spoken_log.append((time.time(), set(words)))
        # split into sentences so long answers start playing sooner
        for sentence in SENTENCE_RE.split(text):
            if sentence.strip():
                await self.queue.put(sentence.strip())

    @staticmethod
    def _normalize(text: str) -> list[str]:
        words = [w.strip(".,!?…-'\"") for w in text.lower().split()]
        return [w for w in words if w]

    def echoes_recent(self, text: str, window: float = 20.0, ratio: float = 0.6) -> bool:
        """True when `text` closely matches something SHIVA spoke in the last
        `window` seconds — i.e. the mic caught SHIVA's own voice looping back
        (there is no hardware echo cancellation). Short utterances are never
        treated as echo, so real commands like "yes" or "approve" always pass."""
        words = self._normalize(text)
        if len(words) < 6:
            return False
        wset = set(words)
        now = time.time()
        combined: set = set()
        for t, sset in self._spoken_log:
            if now - t > window or not sset:
                continue
            if len(wset & sset) / len(wset) >= ratio:
                return True
            combined |= sset
        return bool(combined) and len(wset & combined) / len(wset) >= ratio

    def busy(self) -> bool:
        """True while SHIVA is speaking or has speech queued."""
        return self._speaking.is_set() or not self.queue.empty()

    async def stop(self) -> None:
        """Barge-in: silence SHIVA at once — drop queued speech and cut playback."""
        if not self.busy():
            return
        self._interrupt.set()
        # drop anything still queued
        while not self.queue.empty():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        # kill local playback (ffplay / say), if any
        proc = self._current_proc
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(Exception):
                proc.kill()
        # tell the HUD to stop WebAudio, and release any HUD-playback waiter
        with contextlib.suppress(Exception):
            await self.bus.emit("audio_stop")
        self._hud_done.set()
        await self.bus.state("idle")

    async def wait_until_quiet(self) -> None:
        while self.busy():
            await asyncio.sleep(0.1)

    async def handle_hud_message(self, msg: dict) -> None:
        """Inbound WebSocket messages from the HUD (registered on the bus)."""
        if msg.get("kind") == "audio_done":
            self._hud_done.set()

    # Engines --------------------------------------------------------------
    async def _speak(self, text: str) -> None:
        if self.cfg.eleven_key:
            await self._speak_elevenlabs(text)
        elif self.cfg.tts_engine == "kokoro" and not self._kokoro_failed:
            try:
                await self._speak_kokoro(text)
            except Exception as e:
                self._kokoro_failed = True
                await self.bus.log(f"kokoro unavailable ({e}) — using macOS voice")
                if not self._interrupt.is_set():
                    await self._speak_macos(text)
        else:
            await self._speak_macos(text)

    def _hud_ready(self) -> bool:
        return self.cfg.hud_audio and bool(self.bus.clients)

    async def _speak_elevenlabs(self, text: str) -> None:
        import httpx

        url = (
            f"https://api.elevenlabs.io/v1/text-to-speech/"
            f"{self.cfg.eleven_voice_id}/stream?output_format=mp3_44100_64"
        )
        payload = {
            "text": text,
            "model_id": self.cfg.eleven_model,
            "voice_settings": {
                "stability": self.cfg.eleven_stability,
                "similarity_boost": self.cfg.eleven_similarity,
                "style": self.cfg.eleven_style,
            },
        }
        data = bytearray()
        async with httpx.AsyncClient(timeout=30) as client:
            async with client.stream(
                "POST", url, json=payload, headers={"xi-api-key": self.cfg.eleven_key}
            ) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes():
                    data.extend(chunk)
        if self._hud_ready():
            await self._play_via_hud(bytes(data))
        else:
            await self._play_ffplay(bytes(data))

    async def warm(self) -> None:
        """Preload the TTS model (called during the wake ritual so the first
        greeting lands with zero cold-start)."""
        if self.cfg.tts_engine == "kokoro" and self._kokoro is None and not self._kokoro_failed:
            loop = asyncio.get_running_loop()

            def _load():
                from mlx_audio.tts.utils import load_model
                return load_model(model_path="mlx-community/Kokoro-82M-bf16")
            try:
                self._kokoro = await loop.run_in_executor(None, _load)
                await self.bus.log(f"voice: Kokoro warmed ({self.cfg.kokoro_voice})")
            except Exception as e:
                self._kokoro_failed = True
                await self.bus.log(f"kokoro warm failed ({e}) — macOS voice will cover")

    async def _speak_kokoro(self, text: str) -> None:
        """Local neural TTS (Kokoro-82M on MLX). WAV bytes → HUD lip-sync or ffplay."""
        import numpy as np

        loop = asyncio.get_running_loop()
        if self._kokoro is None:
            def _load():
                from mlx_audio.tts.utils import load_model
                return load_model(model_path="mlx-community/Kokoro-82M-bf16")
            self._kokoro = await loop.run_in_executor(None, _load)
            await self.bus.log(f"voice: Kokoro online ({self.cfg.kokoro_voice})")

        voice = self.cfg.kokoro_voice
        lang = "b" if voice.startswith("b") else "a"  # bm_*/bf_* are British

        def _gen() -> bytes:
            segs = self._kokoro.generate(text=text, voice=voice,
                                         speed=self.cfg.kokoro_speed, lang_code=lang)
            audio = np.concatenate([np.asarray(s.audio) for s in segs])
            pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(24000)
                w.writeframes(pcm.tobytes())
            return buf.getvalue()

        data = await loop.run_in_executor(None, _gen)
        if self._interrupt.is_set():
            return
        duration = (len(data) - 44) / 2 / 24000
        if self._hud_ready():
            await self._play_via_hud(data, timeout=duration + 6)
        else:
            await self._play_ffplay(data)

    async def _play_via_hud(self, data: bytes, timeout: float | None = None) -> None:
        """Ship the audio to the HUD; the browser plays it and animates the avatar."""
        self._hud_done.clear()
        await self.bus.emit("audio", data=base64.b64encode(data).decode())
        if timeout is None:
            # 64 kbps mp3 ≈ 8000 bytes/sec; generous so a stuck HUD never hangs SHIVA
            timeout = len(data) / 4000 + 6
        try:
            await asyncio.wait_for(self._hud_done.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            await self.bus.log("hud audio timeout — falling back to local playback")
            await self._play_ffplay(data)

    async def _play_ffplay(self, data: bytes) -> None:
        import shutil
        ffplay = shutil.which("ffplay") or "/opt/homebrew/bin/ffplay"
        cmd = [ffplay, "-autoexit", "-nodisp", "-loglevel", "quiet"]
        if getattr(self.cfg, "kokoro_fx", ""):
            cmd += ["-af", self.cfg.kokoro_fx]   # character-shaping DSP chain
        cmd += ["-i", "pipe:0"]
        player = await asyncio.create_subprocess_exec(
            *cmd, stdin=asyncio.subprocess.PIPE,
        )
        self._current_proc = player
        try:
            with contextlib.suppress(Exception):
                player.stdin.write(data)
                await player.stdin.drain()
        finally:
            with contextlib.suppress(Exception):
                player.stdin.close()
            await player.wait()
            self._current_proc = None

    async def _speak_macos(self, text: str) -> None:
        if self._macos_voice is None:
            self._macos_voice = await self._resolve_macos_voice()
        proc = await asyncio.create_subprocess_exec(
            "say", "-v", self._macos_voice, "-r", str(self.cfg.macos_rate), text
        )
        self._current_proc = proc
        rc = await proc.wait()
        self._current_proc = None
        # unknown voice — use the system default, never go mute (but not if barged-in)
        if rc != 0 and not self._interrupt.is_set():
            proc = await asyncio.create_subprocess_exec("say", text)
            self._current_proc = proc
            await proc.wait()
            self._current_proc = None

    async def _resolve_macos_voice(self) -> str:
        """Prefer the Premium/Enhanced build of the configured voice if installed."""
        base = self.cfg.macos_voice.split(" (")[0]
        try:
            proc = await asyncio.create_subprocess_exec(
                "say", "-v", "?", stdout=asyncio.subprocess.PIPE
            )
            listing, _ = await proc.communicate()
            names = [line.split("  ")[0].strip() for line in listing.decode().splitlines()]
        except Exception:
            return self.cfg.macos_voice
        for tier in ("Premium", "Enhanced"):
            name = f"{base} ({tier})"
            if name in names:
                await self.bus.log(f"voice: using {name}")
                return name
        return self.cfg.macos_voice
