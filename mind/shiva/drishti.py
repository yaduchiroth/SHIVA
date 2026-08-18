"""Drishti — the wall that sees. Streams the Mac screen to the HUD while SHIVA
acts, so you watch him work: browsing, desktop tasks, code edits, all live.

Streams only while SHIVA is in the "acting" state (plus a short tail), and only
when a HUD is connected. Requires the Screen Recording permission (macOS will
prompt on first capture; grant it to whatever hosts SHIVA — SHIVA.app/Terminal).

The HUD itself runs in a browser window, so a naive grab would catch the HUD
showing its own Drishti panel — an infinite hall of mirrors. Drishti therefore
enumerates on-screen windows (Quartz), skips the HUD window (title "SHIVA") and
system chrome, picks the front-most *content* window — browser page, Keynote,
Terminal, whatever SHIVA is driving — and captures THAT window by id
(`screencapture -l`), which works even when the HUD is fullscreen on top of it.
Each frame ships with the app name so the HUD can caption what you're watching.
"""
import asyncio
import base64
import os
import subprocess
import tempfile
import time

ACTING_TAIL_SECONDS = 8   # keep streaming this long after the last "acting"
FRAME_INTERVAL = 0.7      # ~1.4 fps — smooth enough to follow, cheap to ship

# Windows that are never worth streaming: the HUD itself, system chrome, and
# the tools doing the filming.
_SKIP_OWNERS = {"Window Server", "WindowManager", "Dock", "Control Center",
                "Control Centre", "Notification Center", "Spotlight",
                "SystemUIServer", "screencapture", "QuickTime Player",
                "Screenshot", "Wallpaper"}
_HUD_TITLE = "SHIVA"


class Drishti:
    def __init__(self, cfg, bus) -> None:
        self.cfg = cfg
        self.bus = bus
        self._hot_until = 0.0

    async def run(self) -> None:
        if not self.cfg.screen_stream:
            return
        loop = asyncio.get_running_loop()
        while True:
            now = time.time()
            if self.bus.current_state == "acting":
                self._hot_until = now + ACTING_TAIL_SECONDS
            if now < self._hot_until and self.bus.clients:
                frame = await loop.run_in_executor(None, self._grab)
                if frame:
                    jpg, app, title = frame
                    await self.bus.emit("screen", jpg=base64.b64encode(jpg).decode(),
                                        app=app, title=title)
                await asyncio.sleep(FRAME_INTERVAL)
            else:
                await asyncio.sleep(0.4)

    def _pick_window(self) -> dict | None:
        """Front-most on-screen *content* window that isn't the HUD or system
        chrome. Quartz lists windows front→back, so the first survivor is what
        SHIVA is working in — even when the fullscreen HUD sits on top of it."""
        try:
            import Quartz

            wins = Quartz.CGWindowListCopyWindowInfo(
                Quartz.kCGWindowListOptionOnScreenOnly
                | Quartz.kCGWindowListExcludeDesktopElements,
                Quartz.kCGNullWindowID)
        except Exception:
            return None
        for w in wins or []:
            if w.get("kCGWindowLayer", 1) != 0:
                continue  # menu bar, overlays, floating chrome
            owner = w.get("kCGWindowOwnerName", "") or ""
            title = w.get("kCGWindowName") or ""
            if owner in _SKIP_OWNERS:
                continue
            if _HUD_TITLE in title.upper():
                # never mirror the HUD into itself — substring match, because
                # browsers decorate titles ("Personal — SHIVA" in Safari profiles)
                continue
            b = w.get("kCGWindowBounds", {})
            if b.get("Width", 0) < 420 or b.get("Height", 0) < 300:
                continue  # palettes, pop-ups
            return {"id": int(w["kCGWindowNumber"]), "app": owner, "title": title}
        return None

    def _grab(self):
        """-> (jpg_bytes, app, title) of the picked window, or None to skip."""
        try:
            import cv2

            win = self._pick_window()
            if win is None:
                return None
            with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
                path = f.name
            # -l: capture that window even when occluded; -o: no drop shadow
            subprocess.run(
                ["screencapture", "-x", "-o", "-t", "jpg", "-l", str(win["id"]), path],
                check=True, timeout=5,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            img = cv2.imread(path)
            os.unlink(path)
            if img is None:
                return None
            scale = 960 / img.shape[1]
            img = cv2.resize(img, (960, int(img.shape[0] * scale)))
            ok, enc = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 62])
            return (enc.tobytes(), win["app"], win["title"]) if ok else None
        except Exception:
            return None
