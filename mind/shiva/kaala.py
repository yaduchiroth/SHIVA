"""The Kaala — work that runs itself.

Routines live in automations/<slug>.md: frontmatter says WHEN and WHO, the body
says WHAT, in plain language. The schedule grammar is deliberately spoken-shaped
("weekdays at 08:30") rather than cron, because Boss creates these by voice.

A routine fires by interjecting into SHIVA's conversation, exactly the way Shruti
and the Watchtower do — so a routine can delegate to a companion, put something
on the Well, and speak a headline, using everything SHIVA already has.
"""
import asyncio
import datetime
import json
import os
import re
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import ROOT
from .companions import parse_frontmatter, SLUG_RE

AUTOMATIONS_DIR = ROOT / "automations"
STATE_PATH = ROOT / "data" / "kaala.json"

_DAYS = {"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
         "friday": 4, "saturday": 5, "sunday": 6}


@dataclass
class Routine:
    slug: str
    name: str
    schedule: str
    body: str
    companion: str = ""
    quiet: bool = False
    enabled: bool = True
    last_run: float = 0.0
    meta: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {"slug": self.slug, "name": self.name, "schedule": self.schedule,
                "companion": self.companion, "quiet": self.quiet,
                "enabled": self.enabled, "last_run": self.last_run,
                "next": self.next_fire(time.time())}

    # ── schedule grammar ───────────────────────────────────────────────────
    def next_fire(self, now_ts: float) -> float:
        """-> epoch seconds of the next firing (inf if it never fires by clock)."""
        s = (self.schedule or "").strip().lower()
        now = datetime.datetime.fromtimestamp(now_ts)
        base = datetime.datetime.fromtimestamp(self.last_run) if self.last_run else now

        m = re.match(r"every\s+(\d+)\s*(second|minute|hour|day)s?", s)
        if m:
            n, unit = int(m.group(1)), m.group(2)
            step = {"second": 1, "minute": 60, "hour": 3600, "day": 86400}[unit] * n
            return (self.last_run or now_ts) + step

        tm = re.search(r"at\s+(\d{1,2})[:.](\d{2})", s)
        hh, mm = (int(tm.group(1)), int(tm.group(2))) if tm else (9, 0)

        def at(day: datetime.date) -> float:
            return datetime.datetime.combine(
                day, datetime.time(hh, mm)).timestamp()

        if s.startswith("daily") or ("every day" in s):
            t = at(now.date())
            return t if t > now_ts else at(now.date() + datetime.timedelta(days=1))
        if "weekday" in s:
            d = now.date()
            for i in range(0, 8):
                cand = d + datetime.timedelta(days=i)
                if cand.weekday() < 5 and at(cand) > now_ts:
                    return at(cand)
            return float("inf")
        wk = re.search(r"weekly\s+on\s+(\w+)|every\s+(\w+day)", s)
        if wk:
            name = (wk.group(1) or wk.group(2) or "").strip()
            if name in _DAYS:
                d = now.date()
                for i in range(0, 8):
                    cand = d + datetime.timedelta(days=i)
                    if cand.weekday() == _DAYS[name] and at(cand) > now_ts:
                        return at(cand)
        mo = re.search(r"monthly\s+on\s+(\d{1,2})", s)
        if mo:
            day = int(mo.group(1))
            y, mth = now.year, now.month
            for _ in range(13):
                try:
                    cand = datetime.date(y, mth, day)
                    if at(cand) > now_ts:
                        return at(cand)
                except ValueError:
                    pass
                mth += 1
                if mth > 12:
                    mth, y = 1, y + 1
        return float("inf")   # event-triggered ("on wake") or unparsable


def parse_routine(path: Path) -> Routine | None:
    try:
        meta, body = parse_frontmatter(path.read_text())
    except OSError:
        return None
    slug = str(meta.get("slug") or path.stem).lower()
    if not SLUG_RE.match(slug):
        return None
    return Routine(
        slug=slug,
        name=str(meta.get("name") or slug.replace("-", " ").title()),
        schedule=str(meta.get("schedule") or ""),
        body=body.strip(),
        companion=str(meta.get("companion") or ""),
        quiet=bool(meta.get("quiet", False)),
        enabled=bool(meta.get("enabled", True)),
        meta=meta,
    )


def load_routines() -> list[Routine]:
    if not AUTOMATIONS_DIR.exists():
        return []
    out = []
    state = _load_state()
    for p in sorted(AUTOMATIONS_DIR.glob("*.md")):
        if p.name.startswith("."):
            continue
        r = parse_routine(p)
        if r:
            r.last_run = float(state.get(r.slug, {}).get("last_run", 0))
            out.append(r)
    return out


def _load_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:
        return {}


def _save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile("w", dir=str(STATE_PATH.parent),
                                      suffix=".tmp", delete=False)
    try:
        json.dump(state, tmp, indent=2); tmp.flush(); os.fsync(tmp.fileno())
    finally:
        tmp.close()
    os.replace(tmp.name, STATE_PATH)


class Kaala:
    """The always-on scheduler. One task; holds fire while SHIVA sleeps."""

    def __init__(self, cfg, bus, brain, gate=None) -> None:
        self.cfg = cfg
        self.bus = bus
        self.brain = brain
        self.gate = gate            # () -> bool: False while asleep
        self.routines: list[Routine] = []
        self._fingerprint = 0.0
        self._lock = asyncio.Lock()

    def reload(self) -> bool:
        fp = 0.0
        if AUTOMATIONS_DIR.exists():
            fp = sum(p.stat().st_mtime for p in AUTOMATIONS_DIR.glob("*.md"))
        if fp == self._fingerprint:
            return False
        self._fingerprint = fp
        self.routines = load_routines()
        return True

    async def fire(self, r: Routine) -> None:
        async with self._lock:
            r.last_run = time.time()
            state = _load_state()
            state.setdefault(r.slug, {})["last_run"] = r.last_run
            _save_state(state)
        await self.bus.emit("routine", slug=r.slug, name=r.name,
                            companion=r.companion, quiet=r.quiet)
        who = (f" Delegate this to {r.companion}." if r.companion else "")
        voice_rule = ("Do NOT speak — render the result on the Well only."
                      if r.quiet else
                      "Then give Boss the headline in one or two sentences.")
        await self.brain.interject(
            f"[Automation: {r.name}] {r.body}{who} {voice_rule}")

    async def run(self) -> None:
        self.reload()
        await self.bus.log(f"kaala online ({len(self.routines)} routines)")
        while True:
            try:
                if self.reload():
                    await self.bus.log(f"kaala: routines reloaded ({len(self.routines)})")
                if self.gate is None or self.gate():
                    now = time.time()
                    for r in self.routines:
                        if not r.enabled:
                            continue
                        nxt = r.next_fire(now)
                        if nxt <= now:
                            await self.fire(r)
            except Exception as e:
                await self.bus.log(f"kaala error: {e}")
            await asyncio.sleep(20)
