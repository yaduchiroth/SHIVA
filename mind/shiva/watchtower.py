"""Watchtower — SHIVA's always-on sentinel.

A background alert that watches the business on its own: KPIs, pending
approvals, delayed deliveries and critical complaints. When something crosses
Boss's guardrails it interrupts proactively — the same way Shruti watches the
inbox — instead of waiting to be asked.

Guardrails mirror Boss's travel-autonomy protocol: escalate a decision over a
money ceiling ($100k by default), anything carrying legal risk (vendor
contracts / legal-category items), a delayed delivery, or a critical customer
complaint. Everything quieter is left for SHIVA to handle and brief later.

State persists to data/watchtower.json so it survives a relaunch and never
re-alerts the same item twice.
"""
import asyncio
import json
import time
from typing import Any

from claude_agent_sdk import tool

from .config import ROOT
from .tools_mac import _CTX, _ok

FIXTURES = ROOT / "data" / "demo" / "fixtures.json"


def _fx() -> dict:
    try:
        return json.loads(FIXTURES.read_text())
    except Exception:
        return {}


def _money(value: Any) -> int:
    """Best-effort parse of amounts like '$780,000', 780000 or '0.4M'."""
    if isinstance(value, (int, float)):
        return int(value)
    s = str(value or "").strip().lower().replace("$", "").replace(",", "")
    try:
        if s.endswith("m"):
            return int(float(s[:-1]) * 1_000_000)
        if s.endswith("k"):
            return int(float(s[:-1]) * 1_000)
        return int(float(s))
    except ValueError:
        return 0


class Watchtower:
    def __init__(self, cfg, bus, brain) -> None:
        self.cfg = cfg
        self.bus = bus
        self.brain = brain
        self.path = cfg.data_dir / "watchtower.json"
        self.armed = True
        self.escalate_amount = 100_000  # Boss's guardrail ceiling
        self.poll_seconds = 90
        self.seen: set[str] = set()
        self.first_pass = True
        self._load()

    # -- persistence --------------------------------------------------------
    def _load(self) -> None:
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text())
                self.armed = bool(data.get("armed", True))
                self.escalate_amount = int(data.get("escalate_amount", 100_000))
                self.seen = set(data.get("seen", []))
                # a persisted baseline means we've watched before — don't
                # re-flood on the next boot.
                if self.seen:
                    self.first_pass = False
            except Exception:
                pass

    def _save(self) -> None:
        try:
            self.path.write_text(json.dumps({
                "armed": self.armed,
                "escalate_amount": self.escalate_amount,
                "seen": sorted(self.seen),
            }, indent=2))
        except Exception as e:
            asyncio.create_task(self.bus.log(f"watchtower save failed: {e}"))

    # -- the watch ----------------------------------------------------------
    def _triggers(self) -> list[dict]:
        """Evaluate the current dataset against Boss's guardrails.

        Each trigger: {key, severity, headline, detail}. severity is
        'escalate' (wake Boss) or 'handle' (SHIVA's own).
        """
        fx = _fx()
        out: list[dict] = []
        ceiling = self.escalate_amount

        # 1) Big-ticket approvals + legal-risk contracts
        for a in fx.get("approvals", []):
            amount = _money(a.get("amount"))
            cat = str(a.get("category", "")).lower()
            typ = str(a.get("type", "")).lower()
            item = a.get("item", "an approval")
            legal = "vendor contract" in typ or cat in ("legal", "compliance")
            if amount >= ceiling:
                out.append({
                    "key": f"approval:{a.get('id')}",
                    "severity": "escalate",
                    "headline": f"Approval over ${ceiling:,}",
                    "detail": f"{item} — ${amount:,} [{a.get('category')}], "
                              f"requested by {a.get('requester')}",
                })
            elif legal:
                out.append({
                    "key": f"legal:{a.get('id')}",
                    "severity": "escalate",
                    "headline": "Legal-risk item",
                    "detail": f"{a.get('type')}: {item} — needs Boss's eyes",
                })

        # 2) KPI-level operational risks
        k = fx.get("kpis", {})
        for d in k.get("deliveries_delayed", []):
            order = d.get("order") or d.get("id") or "a delivery"
            out.append({
                "key": f"delay:{order}",
                "severity": "handle",
                "headline": "Delivery delayed",
                "detail": f"{order} — {d.get('customer', 'customer')}: "
                          f"{d.get('reason', 'delay reported')}",
            })
        for c in k.get("critical_complaints", []):
            cust = c.get("customer", "a customer")
            out.append({
                "key": f"complaint:{cust}",
                "severity": "handle",
                "headline": "Critical complaint",
                "detail": f"{cust}: {c.get('issue', 'critical complaint logged')}",
            })

        return out

    async def _alert(self, t: dict) -> None:
        tag = "⚠ ESCALATION" if t["severity"] == "escalate" else "Watchtower"
        await self.bus.alert(f"{tag} — {t['headline']}", t["detail"])
        if t["severity"] == "escalate":
            await self.brain.interject(
                f"[Watchtower — guardrail breached, wake Boss] {t['headline']}: "
                f"{t['detail']}. This crosses Boss's escalation line, so interrupt "
                "him: one sentence on what it is and why it's his call, one sentence "
                "with your recommendation, then ask for his go-ahead."
            )
        else:
            await self.brain.interject(
                f"[Watchtower — handling autonomously, keep Boss informed] "
                f"{t['headline']}: {t['detail']}. Note it briefly, say you're "
                "handling it under his autonomy rules, and move on unless he wants detail."
            )

    async def run(self) -> None:
        await self.bus.log("watchtower armed (guarding KPIs, approvals, deliveries)")
        while True:
            try:
                if self.armed:
                    triggers = self._triggers()
                    fresh = [t for t in triggers if t["key"] not in self.seen]
                    if self.first_pass:
                        # establish a baseline quietly — don't flood on boot
                        self.seen.update(t["key"] for t in triggers)
                        self.first_pass = False
                        self._save()
                    elif fresh:
                        for t in fresh:
                            self.seen.add(t["key"])
                        self._save()
                        for t in fresh:
                            await self._alert(t)
            except Exception as e:
                await self.bus.log(f"watchtower error: {e}")
            await asyncio.sleep(self.poll_seconds)


# ---------------------------------------------------------------------------
@tool("watchtower_status",
      "Report the Watchtower sentinel's state: armed or standing down, the "
      "escalation money ceiling, and what it's currently flagging.", {})
async def watchtower_status(args: dict[str, Any]) -> dict[str, Any]:
    wt: Watchtower | None = _CTX.get("watchtower")
    if not wt:
        return _ok("Watchtower isn't wired up yet.")
    triggers = wt._triggers()
    state = "armed" if wt.armed else "standing down"
    esc = [t for t in triggers if t["severity"] == "escalate"]
    handled = [t for t in triggers if t["severity"] == "handle"]
    lines = [f"Watchtower is {state}. Escalation ceiling: ${wt.escalate_amount:,}."]
    lines.append(f"Would escalate: {len(esc)} — " +
                 ("; ".join(t["headline"] + " (" + t["detail"] + ")" for t in esc) or "none"))
    lines.append(f"Handling autonomously: {len(handled)} — " +
                 ("; ".join(t["headline"] for t in handled) or "none"))
    return _ok("\n".join(lines))


@tool("watchtower_scan",
      "Force the Watchtower to sweep the business right now and report every "
      "current guardrail trigger (escalations and items being handled), without "
      "waiting for its next cycle.", {})
async def watchtower_scan(args: dict[str, Any]) -> dict[str, Any]:
    wt: Watchtower | None = _CTX.get("watchtower")
    if not wt:
        return _ok("Watchtower isn't wired up yet.")
    triggers = wt._triggers()
    if not triggers:
        return _ok("All clear — nothing crossing your guardrails right now.")
    lines = []
    for t in triggers:
        mark = "⚠ ESCALATE" if t["severity"] == "escalate" else "• handle"
        lines.append(f"{mark}: {t['headline']} — {t['detail']}")
    return _ok("\n".join(lines))


@tool("watchtower_arm",
      "Arm or stand down the Watchtower sentinel. armed=true starts proactive "
      "watching; armed=false silences it.", {"armed": bool})
async def watchtower_arm(args: dict[str, Any]) -> dict[str, Any]:
    wt: Watchtower | None = _CTX.get("watchtower")
    if not wt:
        return _ok("Watchtower isn't wired up yet.")
    wt.armed = bool(args.get("armed", True))
    wt._save()
    return _ok("Watchtower armed and watching." if wt.armed
               else "Watchtower standing down — I'll only speak when asked.")


@tool("watchtower_set_threshold",
      "Set the money ceiling above which the Watchtower wakes Boss for a "
      "decision (his guardrail). amount is in dollars, e.g. 100000.",
      {"amount": int})
async def watchtower_set_threshold(args: dict[str, Any]) -> dict[str, Any]:
    wt: Watchtower | None = _CTX.get("watchtower")
    if not wt:
        return _ok("Watchtower isn't wired up yet.")
    amt = int(args.get("amount") or 0)
    if amt <= 0:
        return _ok("Give me a positive dollar ceiling.")
    wt.escalate_amount = amt
    wt._save()
    return _ok(f"Watchtower escalation ceiling set to ${amt:,}.")


WATCHTOWER_TOOLS = [watchtower_status, watchtower_scan,
                    watchtower_arm, watchtower_set_threshold]
