"""Smart home — user-defined IoT devices SHIVA can track and control.

Boss adds devices by voice ("add my living room lamp"); they persist to
data/iot_devices.json and render on the HUD's SMART HOME panel. Each device
may carry an on/off webhook URL (Shelly, Tasmota, Home Assistant, IFTTT,
smart plugs) — when present SHIVA actually switches it; otherwise SHIVA just
tracks its state so the HUD stays a live map of the home.
"""
import json
from pathlib import Path
from typing import Any

import httpx
from claude_agent_sdk import tool

from .tools_mac import _CTX, _ok, _acting

_ICONS = {
    "light": "💡", "lamp": "💡", "bulb": "💡",
    "plug": "🔌", "outlet": "🔌", "switch": "🔌",
    "fan": "🌀", "ac": "❄️", "air conditioner": "❄️", "heater": "🔥",
    "tv": "📺", "television": "📺", "speaker": "🔊", "audio": "🔊",
    "lock": "🔒", "door": "🚪", "thermostat": "🌡️",
    "camera": "🎥", "sensor": "📡", "blind": "🪟", "curtain": "🪟",
    "kettle": "🫖", "coffee": "☕",
}


def _icon(kind: str) -> str:
    k = (kind or "").lower().strip()
    for key, ico in _ICONS.items():
        if key in k:
            return ico
    return "●"


def _path() -> Path:
    cfg = _CTX.get("cfg")
    base = cfg.data_dir if cfg else Path(__file__).resolve().parent.parent / "data"
    return base / "iot_devices.json"


def _load() -> list[dict]:
    p = _path()
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError):
        return []


def _save(items: list[dict]) -> None:
    with open(_path(), "w") as f:
        json.dump(items, f, indent=2)


def _find(items: list[dict], name: str) -> dict | None:
    n = name.lower().strip()
    for d in items:
        if d["name"].lower() == n:
            return d
    for d in items:  # forgiving partial match ("lamp" → "living room lamp")
        if n in d["name"].lower() or d["name"].lower() in n:
            return d
    return None


async def push(bus) -> None:
    """Render the current device list on the HUD."""
    if bus:
        await bus.emit("iot", items=_load())


async def _push_ctx() -> None:
    await push(_CTX.get("bus"))


@tool("add_device", "Register an IoT / smart-home device so SHIVA can track and "
      "control it, showing it on the HUD's SMART HOME panel. 'name' is what Boss "
      "calls it (e.g. 'living room lamp'). 'type' is the kind (light, plug, fan, "
      "tv, ac, lock, speaker, thermostat...). Optional 'on_url' and 'off_url' are "
      "webhook URLs SHIVA hits to switch it (Shelly/Tasmota/Home Assistant/IFTTT); "
      "omit them for a device SHIVA only tracks.",
      {"name": str, "type": str, "on_url": str, "off_url": str})
async def add_device(args: dict[str, Any]) -> dict[str, Any]:
    await _acting(f"add device: {args['name']}")
    items = _load()
    name = args["name"].strip()
    existing = None
    for d in items:
        if d["name"].lower() == name.lower():
            existing = d
            break
    dev = existing or {"state": "off"}
    dev.update({
        "name": name,
        "type": args.get("type", "device").strip() or "device",
        "icon": _icon(args.get("type", "")),
        "on_url": args.get("on_url", "").strip(),
        "off_url": args.get("off_url", "").strip(),
    })
    dev.setdefault("state", "off")
    if not existing:
        items.append(dev)
    _save(items)
    await _push_ctx()
    controllable = " It's wired for on/off control." if dev["on_url"] or dev["off_url"] else ""
    verb = "Updated" if existing else "Added"
    return _ok(f"{verb} {name} to the smart home panel.{controllable}")


@tool("control_device", "Turn a registered IoT device on or off (or 'toggle'). "
      "Hits its webhook if configured, and updates its state on the HUD.",
      {"name": str, "action": str})
async def control_device(args: dict[str, Any]) -> dict[str, Any]:
    await _acting(f"control device: {args['name']} {args['action']}")
    items = _load()
    dev = _find(items, args["name"])
    if not dev:
        names = ", ".join(d["name"] for d in items) or "none yet"
        return _ok(f"I don't have a device called {args['name']}. Registered: {names}.")
    action = args["action"].lower().strip()
    if action == "toggle":
        action = "off" if dev.get("state") == "on" else "on"
    if action not in ("on", "off"):
        return _ok("Action must be on, off, or toggle.")
    url = dev.get("on_url") if action == "on" else dev.get("off_url")
    hit = ""
    if url:
        try:
            async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
                r = await client.get(url)
                r.raise_for_status()
        except Exception as e:
            return _ok(f"Couldn't reach {dev['name']}: {e}")
    else:
        hit = " (tracked only — no control URL set)"
    dev["state"] = action
    _save(items)
    await _push_ctx()
    return _ok(f"{dev['name']} is now {action}.{hit}")


@tool("list_devices", "List the registered IoT / smart-home devices and their "
      "on/off state, and refresh them on the HUD.", {})
async def list_devices(args: dict[str, Any]) -> dict[str, Any]:
    await _push_ctx()
    items = _load()
    if not items:
        return _ok("No smart-home devices registered yet.")
    lines = "\n".join(f"- {d['name']} ({d['type']}): {d.get('state', 'off')}" for d in items)
    return _ok(f"{len(items)} devices:\n{lines}")


@tool("remove_device", "Remove a registered IoT device from the smart home panel.",
      {"name": str})
async def remove_device(args: dict[str, Any]) -> dict[str, Any]:
    await _acting(f"remove device: {args['name']}")
    items = _load()
    dev = _find(items, args["name"])
    if not dev:
        return _ok(f"No device called {args['name']} to remove.")
    items = [d for d in items if d is not dev]
    _save(items)
    await _push_ctx()
    return _ok(f"Removed {dev['name']} from the smart home panel.")


IOT_TOOLS = [add_device, control_device, list_devices, remove_device]
