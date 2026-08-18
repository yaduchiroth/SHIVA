"""SHIVA's on-screen media control — starting/stopping playback (e.g. the relax
song streamed via Safari to the Watch), and the shared "is something playing"
flag that Nandi's wave-to-stop gesture watches.

A shared context (bus) is injected via set_context(), same pattern as tools_mac.
"""
import asyncio
from typing import Any

from claude_agent_sdk import tool

_CTX: dict = {}
_state = {"playing": False}


def set_context(bus, cfg, smriti) -> None:
    _CTX.update(bus=bus, cfg=cfg, smriti=smriti)


def is_playing() -> bool:
    """Plain fn() -> bool, polled by Nandi's wave detector."""
    return _state["playing"]


def _ok(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}]}


async def _run(*cmd: str, timeout: float = 15) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
        )
    except (FileNotFoundError, PermissionError) as exc:
        return 127, str(exc)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 1, "timed out"
    return proc.returncode or 0, out.decode(errors="replace").strip()


async def stop_playback() -> str:
    """Pause whatever is playing in Safari. Used by both the stop_music tool and
    Nandi's wave-to-stop gesture, so a hand wave kills the song instantly even
    with no voice command. Tries a silent JS pause first, falls back to a
    spacebar keystroke (YouTube's play/pause shortcut) if Safari's
    'Allow JavaScript from Apple Events' is off."""
    js = ('tell application "Safari" to do JavaScript '
          '"document.querySelectorAll(\'video,audio\').forEach(function(m){m.pause();});" '
          'in front document')
    code, out = await _run("osascript", "-e", js)
    _state["playing"] = False
    if code == 0:
        return "stopped"
    fallback = ('tell application "Safari" to activate\n'
                'tell application "System Events" to keystroke " "')
    code2, out2 = await _run("osascript", "-e", fallback)
    return "stopped (fallback)" if code2 == 0 else f"failed: {out} / {out2}"


@tool("stop_music", "Stop whatever is playing in Safari on the Watch right now "
      "(e.g. the relax song). Also clears the wave-to-stop flag.", {})
async def stop_music(args: dict[str, Any]) -> dict[str, Any]:
    bus = _CTX.get("bus")
    if bus:
        await bus.state("acting")
        await bus.log("tool: stop_music")
    result = await stop_playback()
    return _ok("Stopped." if not result.startswith("failed") else f"Failed: {result}")


@tool("mark_music_playing",
      "Tell SHIVA that music/video playback has just started (or stopped) on the "
      "Watch. Call this with playing=true right after starting something (e.g. "
      "opening the relax song in Safari) — it arms the wave-to-stop gesture so a "
      "hand wave across the camera kills it instantly. Call with playing=false "
      "if playback ends on its own.",
      {"playing": bool})
async def mark_music_playing(args: dict[str, Any]) -> dict[str, Any]:
    _state["playing"] = bool(args.get("playing", True))
    return _ok("Noted.")


MEDIA_TOOLS = [stop_music, mark_music_playing]
