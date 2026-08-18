"""Kailash — SHIVA's reach across the local network.

Devices on the same Wi-Fi: iPhone, a second Mac, PS5, and anything else
visible on the LAN. All tools degrade to helpful error messages if the
device isn't configured in .env.
"""
import asyncio
import re
from typing import Any

import httpx
from claude_agent_sdk import tool

from .tools_mac import _CTX, _ok, _run, _acting

ARP_RE = re.compile(r"\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+|\(incomplete\))", re.I)


@tool("scan_network", "Scan the local Wi-Fi network and list discovered devices "
      "(IP, MAC, and friendly name where known). Results also render on the HUD "
      "as the Kailash device map.", {})
async def scan_network(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("network scan")
    cfg = _CTX.get("cfg")
    code, out = await _run("arp", "-a", timeout=15)
    devices = []
    for line in out.splitlines():
        m = ARP_RE.search(line)
        if not m or "incomplete" in m.group(2):
            continue
        ip, mac = m.group(1), m.group(2).lower()
        name = ""
        if cfg:
            name = cfg.device_map.get(mac) or cfg.device_map.get(ip) or ""
        host = line.split(" ")[0]
        if not name and host not in ("?", ""):
            name = host.replace(".local", "").replace("-", " ")
        devices.append({"ip": ip, "mac": mac, "name": name or "unknown device"})

    bus = _CTX.get("bus")
    if bus:
        await bus.devices(devices)
    listing = "\n".join(f"- {d['name']}  ({d['ip']})" for d in devices) or "No devices found."
    return _ok(f"{len(devices)} devices on the network:\n{listing}")


@tool("second_mac", "Control the second Mac over SSH. action is one of: "
      "'say' (speak text aloud on it), 'open_app' (open an app), "
      "'script' (run an AppleScript), 'shell' (run a shell command). "
      "value is the text/app/script/command.", {"action": str, "value": str})
async def second_mac(args: dict[str, Any]) -> dict[str, Any]:
    cfg = _CTX.get("cfg")
    if not cfg or not cfg.mac2_ssh:
        return _ok("Second Mac not configured — set MAC2_SSH in .env (e.g. user@192.168.1.42).")
    await _acting(f"second mac: {args['action']}")
    action, value = args["action"], args["value"]
    if action == "say":
        remote = f"say {_sh_quote(value)}"
    elif action == "open_app":
        remote = f"open -a {_sh_quote(value)}"
    elif action == "script":
        remote = f"osascript -e {_sh_quote(value)}"
    else:
        remote = value
    code, out = await _run(
        "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", cfg.mac2_ssh, remote,
        timeout=25,
    )
    return _ok(out or ("Done." if code == 0 else "Command failed — is SSH key auth set up?"))


def _sh_quote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


@tool("playstation", "Wake up or put to sleep the PS5 on the local network. "
      "action: 'wake' or 'standby'.", {"action": str})
async def playstation(args: dict[str, Any]) -> dict[str, Any]:
    cfg = _CTX.get("cfg")
    if not cfg or not cfg.ps5_ip:
        return _ok("PS5 not configured — set PS5_IP in .env and pair once with "
                   "`playactor wake --ip <IP>` (interactive first time).")
    await _acting(f"ps5 {args['action']}")
    action = "standby" if args["action"] == "standby" else "wake"
    code, out = await _run("playactor", action, "--ip", cfg.ps5_ip,
                           "--timeout", "15000", timeout=30)
    if code == 0:
        return _ok(f"PS5 {action} command sent.")
    return _ok(f"PS5 command failed: {out[-300:]}\n"
               "(If this is the first run, pair interactively: playactor wake --ip <IP>)")


@tool("ping_iphone", "Get the user's iPhone to buzz with a message. Sends an iMessage "
      "to the user's own number (appears instantly on their iPhone), or a Pushcut "
      "notification if configured.", {"message": str})
async def ping_iphone(args: dict[str, Any]) -> dict[str, Any]:
    cfg = _CTX.get("cfg")
    msg = args["message"]
    await _acting("ping iphone")
    if cfg and cfg.pushcut_url:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                r = await client.post(cfg.pushcut_url, json={"text": msg, "title": "SHIVA"})
                r.raise_for_status()
            return _ok("Pushcut notification sent to iPhone.")
        except Exception as e:
            if not (cfg and cfg.my_imessage):
                return _ok(f"Pushcut failed: {e}")
    if cfg and cfg.my_imessage:
        script = (
            'tell application "Messages"\n'
            '  set targetService to 1st account whose service type = iMessage\n'
            f'  set targetBuddy to participant "{cfg.my_imessage}" of targetService\n'
            f'  send "{_as_quote(msg)}" to targetBuddy\n'
            "end tell"
        )
        code, out = await _run("osascript", "-e", script)
        return _ok("iMessage sent — check the iPhone." if code == 0
                   else f"iMessage failed: {out}")
    return _ok("iPhone not configured — set MY_IMESSAGE (your own number/email) "
               "or PUSHCUT_URL in .env.")


def _as_quote(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


DEVICE_TOOLS = [scan_network, second_mac, playstation, ping_iphone]
