"""Automation tools — Boss describes a routine out loud, it becomes a file."""
import os
import re
import tempfile
from typing import Any

from claude_agent_sdk import tool

from . import kaala as N
from .tools_mac import _CTX, _ok, _acting


@tool("automation_create",
      "Create a recurring routine that runs itself. schedule is spoken-shaped: "
      "'every 30 minutes', 'daily at 08:30', 'weekdays at 09:00', 'weekly on "
      "monday at 09:00', 'monthly on 1 at 09:00'. body is the instruction in "
      "plain language. companion is the slug it should be delegated to (blank "
      "= SHIVA does it). quiet=true renders to the Well without speaking.",
      {"name": str, "schedule": str, "body": str, "companion": str, "quiet": str})
async def automation_create(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("weaving a routine")
    name = (args.get("name") or "").strip()
    if not name:
        return _ok("The routine needs a name.")
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:24]
    if not N.SLUG_RE.match(slug):
        return _ok(f"'{name}' doesn't make a usable routine name.")
    quiet = str(args.get("quiet", "")).lower() in ("1", "true", "yes")
    text = (f"---\nslug: {slug}\nname: {name}\n"
            f"schedule: {args.get('schedule') or 'daily at 09:00'}\n"
            f"companion: {args.get('companion') or ''}\n"
            f"quiet: {'true' if quiet else 'false'}\nenabled: true\n---\n\n"
            f"{(args.get('body') or '').strip()}\n")
    N.AUTOMATIONS_DIR.mkdir(parents=True, exist_ok=True)
    path = N.AUTOMATIONS_DIR / f"{slug}.md"
    tmp = tempfile.NamedTemporaryFile("w", dir=str(N.AUTOMATIONS_DIR),
                                      suffix=".tmp", delete=False)
    try:
        tmp.write(text); tmp.flush(); os.fsync(tmp.fileno())
    finally:
        tmp.close()
    os.replace(tmp.name, path)
    return _ok(f"Routine '{name}' is woven — {args.get('schedule')}. It picks up "
               f"within the minute; no restart needed.")


@tool("automation_list", "List every recurring routine and when it next runs.", {})
async def automation_list(args: dict[str, Any]) -> dict[str, Any]:
    rs = N.load_routines()
    if not rs:
        return _ok("No routines yet.")
    import datetime
    lines = []
    for r in rs:
        nxt = r.next_fire(__import__("time").time())
        when = ("event-triggered" if nxt == float("inf")
                else datetime.datetime.fromtimestamp(nxt).strftime("%a %H:%M"))
        lines.append(f"- {r.name} ({r.slug}): {r.schedule} → next {when}"
                     + ("" if r.enabled else " [disabled]")
                     + (f", via {r.companion}" if r.companion else "")
                     + (" [quiet]" if r.quiet else ""))
    return _ok("\n".join(lines))


@tool("automation_set", "Enable or disable a routine by slug.",
      {"slug": str, "enabled": str})
async def automation_set(args: dict[str, Any]) -> dict[str, Any]:
    slug = (args.get("slug") or "").strip()
    path = N.AUTOMATIONS_DIR / f"{slug}.md"
    if not path.exists():
        return _ok(f"No routine called '{slug}'.")
    on = str(args.get("enabled", "true")).lower() in ("1", "true", "yes")
    text = re.sub(r"(?m)^enabled:.*$", f"enabled: {'true' if on else 'false'}",
                  path.read_text())
    path.write_text(text)
    return _ok(f"Routine '{slug}' {'enabled' if on else 'disabled'}.")


@tool("automation_run_now", "Run a routine immediately, off-schedule.", {"slug": str})
async def automation_run_now(args: dict[str, Any]) -> dict[str, Any]:
    kaala = _CTX.get("kaala")
    if not kaala:
        return _ok("The Kaala aren't running.")
    slug = (args.get("slug") or "").strip()
    kaala.reload()
    for r in kaala.routines:
        if r.slug == slug:
            import asyncio
            asyncio.create_task(kaala.fire(r))
            return _ok(f"Running '{r.name}' now.")
    return _ok(f"No routine called '{slug}'.")


AUTOMATION_TOOLS = [automation_create, automation_list, automation_set,
                    automation_run_now]
