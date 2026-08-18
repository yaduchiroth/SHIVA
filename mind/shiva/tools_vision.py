"""SHIVA's sight — turn the live camera frame into understanding.

Nandi keeps the most recent camera frame in memory. The `look` tool grabs
that frame, writes it to disk, and hands the path back so SHIVA (which can see
images) can read the scene — the room, objects, what Boss is wearing, whatever
is in view — not just recognized faces.
"""
from typing import Any

from claude_agent_sdk import tool

from .tools_mac import _CTX, _ok


@tool("look",
      "See through the Mac camera right now and describe the whole scene — the "
      "room, objects, people, what Boss is wearing, anything visible (not just "
      "recognized faces). Call this whenever Boss asks what you can see, what "
      "he's wearing, or to read the room. After it returns an image path, READ "
      "that image, then describe what's there in a natural sentence or two.", {})
async def look(args: dict[str, Any]) -> dict[str, Any]:
    nandi = _CTX.get("nandi")
    cfg = _CTX.get("cfg")
    if not nandi or getattr(nandi, "latest_frame", None) is None:
        return _ok("The camera isn't giving me a live picture right now, sir.")
    try:
        import cv2

        vdir = cfg.data_dir / "vision"
        vdir.mkdir(parents=True, exist_ok=True)
        path = vdir / "look.jpg"
        ok = cv2.imwrite(str(path), nandi.latest_frame)
        if not ok:
            return _ok("I couldn't capture the frame just now.")
    except Exception as e:
        return _ok(f"Sight failed: {e}")
    return _ok(f"Live frame captured at {path}. Read this image now, then describe "
               f"the scene aloud for Boss in one or two natural sentences.")


@tool("analyze_scene",
      "Nandi's smart eye — send the live camera frame to the NVIDIA vision "
      "model for a deeper read than a glance gives: describe the room in detail, "
      "count or identify objects, read text/labels/screens in view, assess mood "
      "or activity, or answer any specific visual question. Prefer this over "
      "'look' when Boss wants detail, wants text read, or asks a pointed question "
      "about what's visible. 'question' is what to ask about the scene (optional; "
      "defaults to a full description). Speak the answer back in a sentence or two.",
      {"question": str})
async def analyze_scene(args: dict[str, Any]) -> dict[str, Any]:
    nandi = _CTX.get("nandi")
    cfg = _CTX.get("cfg")
    bus = _CTX.get("bus")
    if not nandi or getattr(nandi, "latest_frame", None) is None:
        return _ok("The camera isn't giving me a live picture right now, sir.")
    if not getattr(cfg, "nvidia_vision_key", ""):
        return _ok("Nandi's smart eye isn't configured yet — no NVIDIA vision key, sir.")
    question = (args.get("question") or "").strip() or \
        "Describe this scene in detail: the room, people, what they're wearing, objects, and any text visible."
    try:
        import base64
        import cv2
        import httpx

        frame = nandi.latest_frame
        # Downscale so the inline base64 payload stays small (NVIDIA inlines
        # images under ~180 KB; 640px JPEG q80 lands well under that).
        h, w = frame.shape[:2]
        if w > 640:
            frame = cv2.resize(frame, (640, int(h * 640 / w)))
        ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok:
            return _ok("I couldn't capture the frame just now.")
        b64 = base64.b64encode(jpg.tobytes()).decode()
        if bus:
            await bus.state("acting")
            await bus.log("tool: analyze_scene (NVIDIA vision)")
        payload = {
            "model": cfg.nvidia_vision_model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": question},
                    {"type": "image_url",
                     "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                ],
            }],
            "max_tokens": 512,
            "temperature": 0.2,
            "stream": False,
        }
        headers = {
            "Authorization": f"Bearer {cfg.nvidia_vision_key}",
            "Accept": "application/json",
        }
        async with httpx.AsyncClient(timeout=45) as client:
            r = await client.post(cfg.nvidia_vision_url, json=payload, headers=headers)
        if r.status_code != 200:
            return _ok(f"The vision model balked (HTTP {r.status_code}), sir — "
                       "I couldn't get a read.")
        answer = (r.json()["choices"][0]["message"]["content"] or "").strip()
    except Exception as e:
        return _ok(f"Nandi's smart eye hit a snag: {e}")
    if not answer:
        return _ok("The vision model came back empty, sir.")
    return _ok("Nandi's smart eye reports:\n" + answer +
               "\n\nRelay this to Boss in one or two natural spoken sentences; "
               "put any long detail on the HUD.")


VISION_TOOLS = [look, analyze_scene]
