"""SHIVA configuration — everything comes from .env, with safe defaults."""
import json
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


# Old names that still work, so an existing .env does not silently lose its
# configuration in the rebrand. Reported once each, at startup, rather than
# swallowed — a variable that quietly stopped being read is the kind of thing
# you only notice weeks later when some feature turns out to have been off.
#
# Keyed by prefix rather than by whole name because that is how they were
# renamed, and because the alternative — a list of forty pairs — goes stale the
# moment anyone adds a setting.
_LEGACY_PREFIXES = {
    "SHIVA_": "ODIN_",
    "NANDI_": "HEIMDALL_",
    "SHRUTI_": "HUGINN_",
    "SMRITI_": "MUNINN_",
    "DRISHTI_": "MIMIR_",
    "VANI_": "BRAGI_",
    "KAALA_": "NORNS_",
}

_DEPRECATED: list[str] = []


def _env(key: str, default: str = "") -> str:
    value = os.environ.get(key)
    if value is None:
        for current, legacy in _LEGACY_PREFIXES.items():
            if not key.startswith(current):
                continue
            old_key = legacy + key[len(current):]
            value = os.environ.get(old_key)
            if value is not None:
                _DEPRECATED.append(f"{old_key} → {key}")
            break
    return (value if value is not None else default).strip()


def deprecated_env() -> list[str]:
    """Old-style variables that were read this run. Printed by __main__."""
    return list(_DEPRECATED)


class Config:
    def __init__(self) -> None:
        # Identity
        self.user_name = _env("SHIVA_USER_NAME", "Boss")
        self.assistant_name = _env("SHIVA_NAME", "SHIVA")
        # Brain model: sonnet answers much faster for secretary work; empty
        # inherits your Claude Code default (may be a slower, larger model).
        self.model = _env("SHIVA_MODEL")

        # ElevenLabs TTS
        self.eleven_key = _env("ELEVENLABS_API_KEY")
        self.eleven_voice_id = _env("ELEVEN_VOICE_ID", "1akQNyt9mMzTni2Y99lv")
        self.eleven_model = _env("ELEVEN_MODEL", "eleven_flash_v2_5")
        self.eleven_stability = float(_env("ELEVEN_STABILITY", "0.45"))
        self.eleven_similarity = float(_env("ELEVEN_SIMILARITY", "0.80"))
        self.eleven_style = float(_env("ELEVEN_STYLE", "0.25"))
        self.macos_voice = _env("MACOS_VOICE", "Daniel")  # offline fallback
        self.macos_rate = int(_env("MACOS_RATE", "172"))  # words/minute
        # Local neural TTS (Kokoro via mlx-audio) — free, fast, drives HUD lip-sync.
        # SHIVA_TTS=kokoro to enable; falls back to macOS `say` on any failure.
        self.tts_engine = _env("SHIVA_TTS", "macos").lower()
        self.kokoro_voice = _env("KOKORO_VOICE", "bm_george")
        self.kokoro_speed = float(_env("KOKORO_SPEED", "1.0"))
        # Optional ffplay -af chain applied to SHIVA's voice (pitch/EQ character shaping)
        self.kokoro_fx = _env("KOKORO_FX")

        # ── Wake ritual & standby ─────────────────────────────────────────
        self.wake_music = _env("WAKE_MUSIC")               # path; empty = no music
        self.wake_music_seconds = float(_env("WAKE_MUSIC_SECONDS", "10"))
        self.wake_greeting = _env("WAKE_GREETING", "Hey Boss, Good Morning.")
        # Boot into standby (clap-clap + "wake up" to rise). 0 = boot awake as before.
        self.standby = _env("SHIVA_STANDBY", "1").lower() in ("1", "true", "yes")
        # Play SHIVA's voice through the HUD (browser) for avatar lip-sync.
        # Falls back to local playback automatically when no HUD is open.
        self.hud_audio = _env("HUD_AUDIO", "1").lower() in ("1", "true", "yes")

        # Wake word / STT
        # After SHIVA replies, reopen the mic for a follow-up — no Enter needed.
        self.followup = _env("SHIVA_FOLLOWUP", "1").lower() in ("1", "true", "yes")
        # Keep the mic open whenever Nandi has a verified face in sight.
        self.open_mic = _env("SHIVA_OPEN_MIC", "1").lower() in ("1", "true", "yes")
        # Echo guard: after SHIVA stops speaking, wait this long before reopening
        # the mic so the speaker's tail and room reverb drain and aren't heard
        # as a fresh utterance (no hardware echo cancellation on the mic).
        self.echo_settle = float(_env("SHIVA_ECHO_SETTLE", "0.6"))
        # Stream the Mac screen to the HUD while SHIVA acts (Drishti).
        self.screen_stream = _env("SHIVA_SCREEN_STREAM", "1").lower() in ("1", "true", "yes")
        # Demo mode (Gjallarhorn): fixture-backed enterprise tools for the CEO video.
        self.demo = _env("SHIVA_DEMO", "0").lower() in ("1", "true", "yes")
        # Which screen the wake ritual raises alongside the Gana: world|connectors
        self.primary_screen = _env("SHIVA_PRIMARY_SCREEN", "world").lower()
        # Council throttle — parallel companions are the main cost driver
        self.max_parallel_dispatch = int(_env("SHIVA_MAX_PARALLEL", "2"))
        self.max_dispatch_per_turn = int(_env("SHIVA_MAX_DISPATCH_TURN", "4"))
        self.picovoice_key = _env("PICOVOICE_ACCESS_KEY")
        self.wake_keyword_path = _env("SHIVA_WAKE_PPN")  # custom "Hey SHIVA" .ppn
        self.wake_builtin = _env("SHIVA_WAKE_BUILTIN", "jarvis")  # built-in fallback keyword
        self.whisper_model = _env("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")

        # Vani — speaker recognition (who is talking) via Resemblyzer d-vectors.
        self.vani_enabled = _env("VANI_ENABLED", "1").lower() in ("1", "true", "yes")
        self.vani_threshold = float(_env("VANI_THRESHOLD", "0.72"))
        # Learn a person's voiceprint automatically while Nandi has their
        # face verified in sight — face proves identity, voice gets memorized.
        self.vani_autolearn = _env("VANI_AUTOLEARN", "1").lower() in ("1", "true", "yes")

        # Devices (Kailash)
        self.mac2_ssh = _env("MAC2_SSH")            # e.g. "yadu@192.168.1.42"
        self.ps5_ip = _env("PS5_IP")                # e.g. "192.168.1.60"
        self.my_imessage = _env("MY_IMESSAGE")      # your own number/email → pings your iPhone
        self.pushcut_url = _env("PUSHCUT_URL")      # optional Pushcut webhook
        try:
            self.device_map = json.loads(_env("DEVICE_MAP", "{}"))
        except json.JSONDecodeError:
            self.device_map = {}

        # Shruti (email watcher) — Gmail app password (myaccount.google.com/apppasswords)
        self.gmail_address = _env("GMAIL_ADDRESS")
        self.gmail_app_password = _env("GMAIL_APP_PASSWORD")
        self.shruti_poll_seconds = int(_env("SHRUTI_POLL_SECONDS", "20"))

        # Nandi — face recognition at the gate
        self.nandi_enabled = _env("NANDI_ENABLED", "1").lower() in ("1", "true", "yes")
        self.camera_index = int(_env("CAMERA_INDEX", "0"))
        self.nandi_absence = int(_env("NANDI_ABSENCE_SECONDS", "120"))
        self.nandi_interval = float(_env("NANDI_INTERVAL", "0.6"))
        self.nandi_threshold = float(_env("NANDI_THRESHOLD", "0.363"))
        self.nandi_greet_guests = _env("NANDI_GREET_GUESTS", "0").lower() in ("1", "true", "yes")
        # Gesture barge-in: wave a hand across the lens to stop SHIVA mid-sentence.
        # Fraction of the frame that must change between frames to count as a wave.
        self.nandi_wave_ratio = float(_env("NANDI_WAVE_RATIO", "0.35"))
        self.nandi_wave_cooldown = float(_env("NANDI_WAVE_COOLDOWN", "2.0"))

        # Nandi's smart eye — NVIDIA vision-language model (cloud scene analysis)
        self.nvidia_vision_key = _env("NVIDIA_VISION_API_KEY")
        self.nvidia_vision_model = _env("NVIDIA_VISION_MODEL",
                                        "meta/llama-3.2-90b-vision-instruct")
        self.nvidia_vision_url = _env("NVIDIA_VISION_URL",
                                      "https://integrate.api.nvidia.com/v1/chat/completions")

        # Dev mode — SHIVA gets Claude Code's own tools (files, shell) + your
        # Claude Code user config (MCP servers, CLAUDE.md). Opt-in.
        self.dev_mode = _env("SHIVA_DEV_MODE", "0").lower() in ("1", "true", "yes")

        # Usage meter — context-window % that counts as "going heavy" and
        # triggers a spoken heads-up (once per crossing, resets when it drops back).
        self.usage_warn_pct = float(_env("SHIVA_USAGE_WARN_PCT", "75"))

        # Servers
        self.hud_http_port = int(_env("HUD_HTTP_PORT", "8377"))
        self.hud_ws_port = int(_env("HUD_WS_PORT", "8765"))

        # Paths
        self.data_dir = ROOT / "data"
        self.data_dir.mkdir(exist_ok=True)
        self.memory_path = self.data_dir / "smriti.json"
        # The interface is Next, served separately. What remains on
        # hud_http_port is the read API the config and connector screens use.
        self.root = ROOT
