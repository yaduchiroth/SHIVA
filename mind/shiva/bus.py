"""Event bus — broadcasts SHIVA's state to the HUD over WebSocket, serves the HUD page."""
import asyncio
import contextlib
import functools
import http.server
import json
import threading
import time


class Bus:
    def __init__(self, cfg) -> None:
        self.cfg = cfg
        self.clients: set = set()
        self._ws_server = None
        self._history: list[dict] = []
        self.on_client_message = None  # async fn(dict) — set by voice for audio_done
        self.current_state = "idle"    # mirrors the last state() — read by Drishti
        self.loop = None               # captured in start(); HTTP threads bridge via it
        self._subs: dict = {}          # ws -> set(kinds) | None (None = everything)
        self._sticky: dict = {}        # kind -> latest event, always resent on connect

    # Live, moment-in-time events — replaying these to a late-joining screen
    # would draw beams for work that finished minutes ago.
    NO_REPLAY = {"audio", "camera", "screen", "dispatch", "dispatch_return",
                 "dispatch_clear", "companion", "companion_tool", "companion_stream"}

    # Standing-state events — a late-joining/reconnecting screen (e.g. the
    # World view after a reload) needs the CURRENT value even if the plain
    # 30-event replay window has long since scrolled past it.
    STICKY = {"roster", "devices"}

    async def start(self) -> None:
        import asyncio
        import websockets

        self.loop = asyncio.get_running_loop()

        async def handler(ws):
            self.clients.add(ws)
            # sticky state first — guarantees a reconnecting World/Sanctum
            # screen gets the current roster/devices even if the 30-event
            # replay window below has scrolled past those events
            for ev in self._sticky.values():
                with contextlib.suppress(Exception):
                    await ws.send(json.dumps(ev))
            # replay recent history so a freshly-opened HUD isn't blank
            for ev in self._history[-30:]:
                with contextlib.suppress(Exception):
                    await ws.send(json.dumps(ev))
            try:
                async for raw in ws:
                    msg = None
                    with contextlib.suppress(Exception):
                        msg = json.loads(raw)
                    if isinstance(msg, dict) and msg.get("kind") == "subscribe":
                        # a screen opting out of bulky feeds (e.g. the World View
                        # doesn't want camera/screen frames)
                        kinds = msg.get("kinds")
                        self._subs[ws] = set(kinds) if isinstance(kinds, list) else None
                        continue
                    if msg is not None and self.on_client_message:
                        with contextlib.suppress(Exception):
                            await self.on_client_message(msg)
            finally:
                self.clients.discard(ws)
                self._subs.pop(ws, None)

        self._ws_server = await websockets.serve(
            handler, "127.0.0.1", self.cfg.hud_ws_port, max_size=16 * 1024 * 1024)
        self._start_http()

    # keys the Connectors screen may write into .env — nothing else is touched
    _CONNECTOR_KEYS = {
        "GMAIL_ADDRESS", "GMAIL_APP_PASSWORD", "ELEVENLABS_API_KEY",
        "PICOVOICE_ACCESS_KEY", "SHIVA_WAKE_PPN", "NVIDIA_VISION_API_KEY",
        "MY_IMESSAGE", "MAC2_SSH", "PS5_IP", "PUSHCUT_URL",
    }

    def _start_http(self) -> None:
        cfg = self.cfg
        keys = self._CONNECTOR_KEYS
        bus_ref = self
        from .tools_mac import _CTX as _ctx

        class QuietHandler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args, **kwargs):
                pass  # silence request logging

            # The face is served by Next on :3000, so every one of these reads
            # is cross-origin. Named origins rather than "*" — this server can
            # write .env and relaunch the process, and a wildcard would let any
            # page you happen to have open reach it.
            ALLOWED_ORIGINS = {"http://localhost:3000", "http://127.0.0.1:3000"}

            def _cors(self) -> None:
                origin = self.headers.get("Origin", "")
                if origin in self.ALLOWED_ORIGINS:
                    self.send_header("Access-Control-Allow-Origin", origin)
                    self.send_header("Access-Control-Allow-Headers", "content-type")
                    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

            def do_OPTIONS(self):
                self.send_response(204)
                self._cors()
                self.end_headers()

            def _json(self, code: int, obj: dict) -> None:
                body = json.dumps(obj).encode()
                self.send_response(code)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == "/api/status":
                    import os
                    # booleans only — secret VALUES never leave the process
                    return self._json(200, {k: bool(os.environ.get(k, "").strip())
                                            for k in sorted(keys)})
                if self.path == "/api/companions":
                    from . import companions as C
                    return self._json(200, {
                        "companions": [
                            {"slug": c.slug, "name": c.name, "role": c.role,
                             "color": c.color, "model": c.model, "trigger": c.trigger,
                             "groups": c.groups, "skills": c.skills,
                             "orbit": c.orbit, "max": C.MAX_COMPANIONS}
                            for c in C.load()],
                        "skills": C.skill_summary(),
                        "groups": sorted(C.TOOL_GROUPS),
                    })
                if self.path == "/api/knowledge":
                    from .knowledge import Knowledge
                    kb = Knowledge()
                    return self._json(200, {"docs": [
                        {"slug": d.slug, "title": d.title, "tags": d.tags,
                         "always": d.always, "updated": d.updated,
                         "summary": d.summary()} for d in kb.docs]})
                if self.path == "/api/automations":
                    from .kaala import load_routines
                    return self._json(200, {"routines": [r.as_dict() for r in load_routines()]})
                # No static fallback any more. The HUD this used to serve was
                # replaced by the spatial interface, which Next serves on :3000
                # — leaving SimpleHTTPRequestHandler's file serving in place
                # would expose the whole project directory over HTTP for nothing.
                return self._json(404, {"error": "not found"})

            def do_POST(self):
                try:
                    n = int(self.headers.get("Content-Length", 0))
                    payload = json.loads(self.rfile.read(n) or b"{}")
                except Exception:
                    return self._json(400, {"error": "bad json"})
                if self.path == "/api/connectors":
                    updates = {k: str(v).strip() for k, v in payload.items() if k in keys}
                    if not updates:
                        return self._json(400, {"error": "no valid keys"})
                    self._rewrite_env(updates)
                    import os
                    os.environ.update(updates)   # visible to /api/status immediately
                    return self._json(200, {"saved": sorted(updates),
                                            "note": "relaunch to apply"})
                if self.path == "/api/reload":
                    # bring roster/knowledge changes live without a restart —
                    # HTTP runs on a daemon thread, so bridge to the loop
                    import asyncio as _a
                    brain = _ctx.get("brain")
                    if not (brain and bus_ref.loop):
                        return self._json(503, {"error": "brain not ready"})
                    fut = _a.run_coroutine_threadsafe(brain.reload_companions(), bus_ref.loop)
                    try:
                        return self._json(200, {"note": fut.result(timeout=30)})
                    except Exception as e:
                        return self._json(500, {"error": str(e)})
                if self.path == "/api/relaunch":
                    import subprocess
                    subprocess.Popen(["bash", str(cfg.root / "relaunch.sh")],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    return self._json(200, {"relaunching": True})
                return self._json(404, {"error": "unknown endpoint"})

            @staticmethod
            def _rewrite_env(updates: dict) -> None:
                """Update keys in .env in place, preserving comments/order."""
                path = cfg.root / ".env"
                lines = path.read_text().splitlines() if path.exists() else []
                remaining = dict(updates)
                out = []
                for ln in lines:
                    key = ln.split("=", 1)[0].strip() if "=" in ln and not ln.lstrip().startswith("#") else None
                    if key in remaining:
                        out.append(f"{key}={remaining.pop(key)}")
                    else:
                        out.append(ln)
                for k, v in remaining.items():
                    out.append(f"{k}={v}")
                path.write_text("\n".join(out) + "\n")

        handler = functools.partial(QuietHandler, directory=str(cfg.root))

        def serve():
            with http.server.ThreadingHTTPServer(("127.0.0.1", self.cfg.hud_http_port), handler) as srv:
                srv.serve_forever()

        threading.Thread(target=serve, daemon=True).start()

    async def emit(self, kind: str, **payload) -> None:
        ev = {"kind": kind, "ts": time.time(), **payload}
        if kind in self.STICKY:
            self._sticky[kind] = ev
        if kind not in self.NO_REPLAY:  # blobs and live-only events aren't replayed
            self._history.append(ev)
        if len(self._history) > 200:
            self._history = self._history[-200:]
        dead = []
        raw = json.dumps(ev)
        for ws in list(self.clients):
            subs = self._subs.get(ws)
            if subs is not None and kind not in subs:
                continue  # this screen asked not to receive this kind
            try:
                await ws.send(raw)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    # Convenience emitters -------------------------------------------------
    async def state(self, name: str) -> None:
        self.current_state = name
        await self.emit("state", value=name)  # idle|listening|thinking|speaking|acting

    async def transcript(self, who: str, text: str) -> None:
        await self.emit("transcript", who=who, text=text)

    async def alert(self, title: str, body: str = "") -> None:
        await self.emit("alert", title=title, body=body)

    async def devices(self, items: list) -> None:
        await self.emit("devices", items=items)

    async def card(self, title: str, body: str) -> None:
        await self.emit("card", title=title, body=body)

    async def log(self, text: str) -> None:
        await self.emit("log", text=text)
        print(f"[shiva] {text}")
