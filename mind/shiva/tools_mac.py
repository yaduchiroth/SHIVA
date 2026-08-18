"""SHIVA's hands on this Mac — AppleScript, apps, volume, calendar.

These are SDK MCP tools registered with the Claude Agent SDK in brain.py.
A shared context (bus, cfg, smriti) is injected via set_context().
"""
import asyncio
import json
from typing import Any

from claude_agent_sdk import tool

_CTX: dict = {}


def set_context(bus, cfg, smriti) -> None:
    _CTX.update(bus=bus, cfg=cfg, smriti=smriti)


def _ok(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}]}


async def _run(*cmd: str, timeout: float = 20) -> tuple[int, str]:
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


async def _acting(label: str) -> None:
    bus = _CTX.get("bus")
    if bus:
        await bus.state("acting")
        await bus.log(f"tool: {label}")


# ---------------------------------------------------------------------------
@tool("run_applescript", "Run an AppleScript on this Mac and return its output. "
      "Use for anything macOS can do: control apps, windows, Keynote slides, "
      "system settings, notifications.", {"script": str})
async def run_applescript(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("applescript")
    code, out = await _run("osascript", "-e", args["script"])
    return _ok(out if code == 0 else f"AppleScript error: {out}")


@tool("open_app", "Open (or focus) a macOS application by name, optionally with a file.",
      {"app": str, "file_path": str})
async def open_app(args: dict[str, Any]) -> dict[str, Any]:
    await _acting(f"open {args['app']}")
    cmd = ["open", "-a", args["app"]]
    if args.get("file_path"):
        cmd.append(args["file_path"])
    code, out = await _run(*cmd)
    return _ok("Opened." if code == 0 else f"Failed: {out}")


@tool("set_volume", "Set this Mac's output volume, 0-100.", {"percent": int})
async def set_volume(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("volume")
    pct = max(0, min(100, int(args["percent"])))
    code, out = await _run("osascript", "-e", f"set volume output volume {pct}")
    return _ok(f"Volume set to {pct}%." if code == 0 else f"Failed: {out}")


@tool("calendar_today", "Get today's calendar events from the macOS Calendar "
      "(uses icalBuddy if installed, AppleScript otherwise).", {})
async def calendar_today(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("calendar")
    code, out = await _run("icalBuddy", "-npn", "-nc", "eventsToday", timeout=15)
    if code == 0 and out:
        return _ok(out)
    script = (
        'set output to ""\n'
        "tell application \"Calendar\"\n"
        "  set today to current date\n"
        "  set startOfDay to today - (time of today)\n"
        "  set endOfDay to startOfDay + 1 * days\n"
        "  repeat with cal in calendars\n"
        "    repeat with ev in (every event of cal whose start date ≥ startOfDay "
        "and start date < endOfDay)\n"
        "      set output to output & (start date of ev as string) & \" — \" "
        "& (summary of ev) & \"\\n\"\n"
        "    end repeat\n"
        "  end repeat\n"
        "end tell\n"
        "return output"
    )
    code, out = await _run("osascript", "-e", script, timeout=45)
    return _ok(out or "No events today.")


@tool("hud_display", "Show a card on the SHIVA HUD screen. Use for details that are "
      "too long to speak: schedules, email lists, summaries.", {"title": str, "body": str})
async def hud_display(args: dict[str, Any]) -> dict[str, Any]:
    bus = _CTX.get("bus")
    if bus:
        await bus.card(args["title"], args["body"])
    return _ok("Displayed on HUD.")


def _rows(body: str) -> list[dict]:
    """Parse a multi-line 'A | B | C' body into row dicts for HUD panels."""
    items: list[dict] = []
    for ln in (body or "").splitlines():
        ln = ln.strip()
        if not ln:
            continue
        parts = [p.strip() for p in ln.split("|")]
        soon = parts[-1].lower() == "soon"
        if soon:
            parts = parts[:-1]
        items.append({
            "when": parts[0] if parts else "",
            "title": parts[1] if len(parts) > 1 else (parts[0] if parts else ""),
            "sub": parts[2] if len(parts) > 2 else "",
            "soon": soon,
        })
    return items


@tool("hud_calendar", "Populate the HUD's TODAY · CALENDAR panel. 'body' is one event "
      "per line as 'TIME | Title | optional detail'. Append ' | soon' to highlight one.",
      {"body": str})
async def hud_calendar(args: dict[str, Any]) -> dict[str, Any]:
    bus = _CTX.get("bus")
    if bus:
        await bus.emit("calendar", items=_rows(args["body"]))
    return _ok("Calendar shown on HUD.")


@tool("hud_meetings", "Populate the HUD's UPCOMING MEETINGS panel. 'body' is one meeting "
      "per line as 'TIME | Title | attendees/location'. Append ' | soon' to highlight one.",
      {"body": str})
async def hud_meetings(args: dict[str, Any]) -> dict[str, Any]:
    bus = _CTX.get("bus")
    if bus:
        await bus.emit("meetings", items=_rows(args["body"]))
    return _ok("Meetings shown on HUD.")


@tool("hud_email", "Populate the HUD's EMAIL · UNREAD panel. 'body' is one message per "
      "line as 'Sender | Subject | preview'.", {"body": str})
async def hud_email(args: dict[str, Any]) -> dict[str, Any]:
    bus = _CTX.get("bus")
    if bus:
        await bus.emit("email", items=_rows(args["body"]))
    return _ok("Email shown on HUD.")


@tool("hud_chart",
      "Draw a real chart on the Well (the HUD's big screen). type is bar, line, "
      "or donut. labels is a comma-separated category list. series is JSON like "
      '[{"name":"Actual","values":[412.8,388.7]}] — values align with labels '
      "(donut uses the first series only). unit is an optional value suffix "
      "like $K or %. Use for ANY request to graph, chart, plot, compare, or "
      "visualize numbers — never draw charts out of text characters.",
      {"title": str, "type": str, "labels": str, "series": str, "unit": str})
async def hud_chart(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("chart")
    bus = _CTX.get("bus")
    try:
        series = json.loads(args.get("series") or "[]")
        assert isinstance(series, list)
    except Exception:
        return _ok('series must be JSON like [{"name":"A","values":[1,2]}].')

    def _num(v) -> float:
        if isinstance(v, (int, float)):
            return float(v)
        s = str(v).replace(",", "").replace("$", "").strip().upper()
        mult = 1.0
        if s.endswith("M"):
            mult, s = 1e6, s[:-1]
        elif s.endswith("K"):
            mult, s = 1e3, s[:-1]
        try:
            return float(s) * mult
        except ValueError:
            return 0.0

    # normalize whatever shape the model produced: values|data|y, strings ok
    norm = []
    for s in series:
        if not isinstance(s, dict):
            continue
        vals = s.get("values") or s.get("data") or s.get("y") or []
        norm.append({"name": str(s.get("name") or s.get("label") or ""),
                     "values": [_num(v) for v in vals]})
    series = [s for s in norm if s["values"]]
    if not series:
        return _ok("I need at least one series with numeric values.")
    labels = [s.strip() for s in (args.get("labels") or "").split(",") if s.strip()]
    if bus:
        await bus.emit("chart", title=args.get("title") or "",
                       ctype=(args.get("type") or "bar").lower(),
                       labels=labels, series=series, unit=args.get("unit") or "")
    return _ok("Chart is up on the Well.")


@tool("hud_report",
      "Render a rich custom report on the Well (the HUD's big screen): full "
      "HTML — headings, tables, columns, inline SVG. Dark theme; use inline "
      "styles sparingly and the palette gold #e8b93c, teal #41e0d6, violet "
      "#9b86ff on transparent backgrounds. Use when Boss asks for a report, "
      "breakdown, comparison table, or dashboard that a single chart can't hold.",
      {"title": str, "html": str})
async def hud_report(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("report")
    bus = _CTX.get("bus")
    if bus:
        await bus.emit("report", title=args.get("title") or "",
                       html=args.get("html") or "")
    return _ok("Report is up on the Well.")


@tool("hud_web",
      "Embed a live web page on the Well (the HUD's big screen) by URL — the "
      "HUD acts as the browser. Some sites refuse embedding and show blank: "
      "if Boss says it's blank, open the same URL in Safari instead (open_app "
      "or AppleScript) and Drishti will stream that window onto the Well.",
      {"url": str, "title": str})
async def hud_web(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("web on the Well")
    bus = _CTX.get("bus")
    url = (args.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        return _ok("I need a full http(s) URL.")
    if bus:
        await bus.emit("webview", url=url, title=args.get("title") or url)
    return _ok(f"{url} is up on the Well. If it renders blank the site refuses "
               "embedding — open it in Safari and Drishti will stream it.")


@tool("hud_clear",
      "Clear the Well (the HUD's big screen) — removes any pinned chart, "
      "report, or web page and returns it to the live Drishti stream/standby.", {})
async def hud_clear(args: dict[str, Any]) -> dict[str, Any]:
    bus = _CTX.get("bus")
    if bus:
        await bus.emit("wellclear")
    return _ok("The Well is clear.")


@tool("ring_light", "Turn the on-screen ring / mirror fill light on or off — a glowing "
      "frame around the whole HUD screen that lights the user's face for the camera. "
      "'on' is 'on' or 'off'; 'color' is any CSS color (default warm white); 'width' is "
      "the frame thickness in pixels (default 34).",
      {"on": str, "color": str, "width": str})
async def ring_light(args: dict[str, Any]) -> dict[str, Any]:
    bus = _CTX.get("bus")
    on = str(args.get("on", "on")).strip().lower() in ("on", "true", "1", "yes")
    color = (args.get("color") or "").strip() or "#fff4e0"
    width = (args.get("width") or "").strip() or "34"
    if bus:
        await bus.emit("ringlight", on=on, color=color, width=width)
    return _ok(f"Ring light {'on' if on else 'off'}.")


@tool("remember", "Store a durable fact/preference in SHIVA's memory (Smriti). "
      "Use whenever the user states a preference or asks you to remember something.",
      {"fact": str})
async def remember(args: dict[str, Any]) -> dict[str, Any]:
    smriti = _CTX.get("smriti")
    if smriti:
        smriti.remember(args["fact"])
    bus = _CTX.get("bus")
    if bus:
        await bus.emit("smriti", action="remember")
    return _ok("Remembered.")


@tool("recall_memories", "Retrieve everything stored in SHIVA's memory (Smriti).", {})
async def recall_memories(args: dict[str, Any]) -> dict[str, Any]:
    smriti = _CTX.get("smriti")
    bus = _CTX.get("bus")
    if bus:
        await bus.emit("smriti", action="recall")
    return _ok(smriti.as_prompt() if smriti else "Memory unavailable.")


MAC_TOOLS = [run_applescript, open_app, set_volume, calendar_today,
             hud_display, hud_calendar, hud_meetings, hud_email,
             hud_chart, hud_report, hud_web, hud_clear,
             ring_light, remember, recall_memories]
