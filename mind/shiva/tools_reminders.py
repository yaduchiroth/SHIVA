"""Reminders & timers — SHIVA's sense of time.

Boss can say "remind me in 20 minutes to check the oven" or "wake me at 6".
The brain works out WHEN (it knows the current date/time) and calls set_reminder
with either a delay in seconds or an absolute ISO timestamp. A background loop
watches the clock and, when a reminder is due, interjects so SHIVA speaks it aloud.

Reminders persist to data/reminders.json, so they survive a relaunch.
"""
import asyncio
import datetime
import json
import time
from typing import Any

from claude_agent_sdk import tool

from .tools_mac import _CTX, _ok


class Reminders:
    def __init__(self, cfg, bus, brain, gate=None) -> None:
        self.cfg = cfg
        self.bus = bus
        self.brain = brain
        self.gate = gate  # plain fn() -> bool: False while SHIVA sleeps (hold fire)
        self.path = cfg.data_dir / "reminders.json"
        self.items: list[dict] = []
        self._next_id = 1
        self._load()

    # -- persistence --------------------------------------------------------
    def _load(self) -> None:
        if self.path.exists():
            try:
                self.items = json.loads(self.path.read_text())
            except Exception:
                self.items = []
        if self.items:
            self._next_id = max(int(i.get("id", 0)) for i in self.items) + 1

    def _save(self) -> None:
        try:
            self.path.write_text(json.dumps(self.items, indent=2))
        except Exception as e:
            # best effort — never crash the loop over disk issues
            asyncio.create_task(self.bus.log(f"reminders save failed: {e}"))

    # -- public API used by the tools --------------------------------------
    def add(self, message: str, fire_at: float) -> dict:
        item = {"id": self._next_id, "message": message.strip(),
                "fire_at": float(fire_at), "created": time.time()}
        self._next_id += 1
        self.items.append(item)
        self._save()
        return item

    def cancel(self, rid: int) -> bool:
        before = len(self.items)
        self.items = [i for i in self.items if int(i["id"]) != int(rid)]
        if len(self.items) != before:
            self._save()
            return True
        return False

    def pending(self) -> list[dict]:
        return sorted(self.items, key=lambda i: i["fire_at"])

    # -- background clock ---------------------------------------------------
    async def run(self) -> None:
        await self.bus.log("reminders online (watching the clock)")
        while True:
            try:
                if self.gate and not self.gate():
                    await asyncio.sleep(5)   # asleep — due reminders hold until wake
                    continue
                now = time.time()
                due = [i for i in self.items if i["fire_at"] <= now]
                if due:
                    for item in due:
                        self.items.remove(item)
                    self._save()
                    for item in due:
                        await self.bus.alert("Reminder", item["message"])
                        await self.brain.interject(
                            f"[Reminder due] Boss asked to be reminded: "
                            f"\"{item['message']}\". Deliver this reminder aloud now, "
                            f"warmly and briefly."
                        )
            except Exception as e:
                await self.bus.log(f"reminders error: {e}")
            await asyncio.sleep(5)


def _humanize(fire_at: float) -> str:
    dt = datetime.datetime.fromtimestamp(fire_at)
    delta = fire_at - time.time()
    if delta < 90:
        when = f"in {max(1, round(delta))} seconds"
    elif delta < 3600:
        when = f"in {round(delta / 60)} minutes"
    elif dt.date() == datetime.date.today():
        when = f"at {dt.strftime('%-I:%M %p').lower()}"
    else:
        when = dt.strftime("%A at %-I:%M %p").replace("AM", "am").replace("PM", "pm")
    return when


# ---------------------------------------------------------------------------
@tool("set_reminder",
      "Set a reminder or timer that SHIVA will speak aloud when it comes due. "
      "You know the current date/time — work out when it should fire and pass "
      "EITHER in_seconds (a delay from now, e.g. 1200 for 20 minutes) OR "
      "fire_at_iso (an absolute local time like '2026-07-22T18:00:00'). "
      "message is what to remind Boss about, phrased as the reminder text.",
      {"message": str, "in_seconds": int, "fire_at_iso": str})
async def set_reminder(args: dict[str, Any]) -> dict[str, Any]:
    reminders: Reminders | None = _CTX.get("reminders")
    if not reminders:
        return _ok("Reminders aren't wired up yet.")
    message = (args.get("message") or "").strip()
    if not message:
        return _ok("I need to know what to remind you about.")

    in_seconds = args.get("in_seconds") or 0
    iso = (args.get("fire_at_iso") or "").strip()
    if in_seconds and int(in_seconds) > 0:
        fire_at = time.time() + int(in_seconds)
    elif iso:
        try:
            fire_at = datetime.datetime.fromisoformat(iso).timestamp()
        except ValueError:
            return _ok(f"I couldn't parse that time: {iso}.")
    else:
        return _ok("Tell me when — a delay or a specific time.")

    if fire_at <= time.time():
        return _ok("That time's already passed, sir.")

    item = reminders.add(message, fire_at)
    return _ok(f"Reminder #{item['id']} set for {_humanize(fire_at)}: {message}")


@tool("list_reminders", "List all pending reminders and timers.", {})
async def list_reminders(args: dict[str, Any]) -> dict[str, Any]:
    reminders: Reminders | None = _CTX.get("reminders")
    if not reminders:
        return _ok("Reminders aren't wired up yet.")
    items = reminders.pending()
    if not items:
        return _ok("No reminders set.")
    lines = [f"#{i['id']} — {_humanize(i['fire_at'])}: {i['message']}" for i in items]
    return _ok("\n".join(lines))


@tool("cancel_reminder", "Cancel a pending reminder by its id.", {"id": int})
async def cancel_reminder(args: dict[str, Any]) -> dict[str, Any]:
    reminders: Reminders | None = _CTX.get("reminders")
    if not reminders:
        return _ok("Reminders aren't wired up yet.")
    if reminders.cancel(int(args["id"])):
        return _ok(f"Reminder #{args['id']} cancelled.")
    return _ok(f"No reminder with id {args['id']}.")


REMINDER_TOOLS = [set_reminder, list_reminders, cancel_reminder]
