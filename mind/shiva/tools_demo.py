"""Demo mode — Gjallarhorn. Fixture-backed enterprise tools for the CEO video.

Real engine, staged data: these tools expose a realistic company dataset
(data/demo/fixtures.json — inbox, KPIs, approvals, crisis, montage) so SHIVA
genuinely reasons, speaks, and drives the HUD while the enterprise systems
are simulated. Enabled with SHIVA_DEMO=1; invisible otherwise.

Scene drivers (not tools — typed in the terminal between takes):
    demo crisis    fire the $850k shipment interrupt
    demo montage   run the 72-hour "CEO travels" fast-forward
"""
import asyncio
import json
from typing import Any

from claude_agent_sdk import tool

from .config import ROOT
from .tools_mac import _CTX, _ok, _acting

FIXTURES = ROOT / "data" / "demo" / "fixtures.json"


def _fx() -> dict:
    try:
        return json.loads(FIXTURES.read_text())
    except Exception:
        return {}


async def _card(title: str, body: str) -> None:
    bus = _CTX.get("bus")
    if bus:
        await bus.card(title, body)


# ── tools ────────────────────────────────────────────────────────────────────
@tool("inbox_triage",
      "Triage the executive inbox: returns unread count, how everything was "
      "filed (Urgent / Need Approval / Delegate / Finance / Customers / Ignore) "
      "and the urgent items. Also renders the email panel and a folder card on "
      "the HUD. Use when Boss asks about email or the inbox.", {})
async def inbox_triage(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("inbox triage")
    fx = _fx().get("inbox", {})
    bus = _CTX.get("bus")
    if bus:
        await bus.emit("email", items=[
            {"when": m["from"], "title": m["subject"], "sub": m["preview"], "soon": True}
            for m in fx.get("urgent", [])
        ])
    folders = fx.get("folders", {})
    await _card("Inbox — processed",
                "\n".join(f"{k}: {v}" for k, v in folders.items()))
    urgent = "\n".join(f"- {m['from']}: {m['subject']}" for m in fx.get("urgent", []))
    return _ok(f"{fx.get('unread_total', 0)} unread — all processed and filed.\n"
               f"Folders: {json.dumps(folders)}\nUrgent items:\n{urgent}")


@tool("draft_client_reply",
      "Draft the reply to the urgent client email (Meridian timeline). Returns "
      "the full drafted email with attachment and scheduled follow-up, and puts "
      "the draft on the HUD. Nothing sends until Boss approves.", {})
async def draft_client_reply(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("drafting client reply")
    r = _fx().get("inbox", {}).get("client_reply", {})
    await _card(f"Draft — {r.get('subject', 'reply')}",
                f"To: {r.get('to')}\n\n{r.get('body')}\n\n"
                f"📎 {r.get('attachment')}\n{r.get('followup')}")
    return _ok(f"Draft ready on screen. To: {r.get('to')}. Attachment: "
               f"{r.get('attachment')}. {r.get('followup')}. "
               f"Awaiting Boss's approval to send.")


@tool("send_approved_reply",
      "Send the client reply Boss just approved (demo dataset — marks it sent "
      "and confirms). Only call after Boss explicitly approves.", {})
async def send_approved_reply(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("sending approved reply")
    r = _fx().get("inbox", {}).get("client_reply", {})
    return _ok(f"Sent to {r.get('to')} with {r.get('attachment')} attached. "
               f"{r.get('followup')}.")


@tool("company_kpis",
      "Executive snapshot: yesterday's revenue, deals closed, payments received, "
      "approvals pending, staff on leave, critical complaints, delayed "
      "deliveries, competitor news, and the decisions needing Boss today. "
      "Renders a snapshot card on the HUD. Use for the morning brief.", {})
async def company_kpis(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("company KPIs")
    k = _fx().get("kpis", {})
    deals = "\n".join(f"  {d['client']} — {d['value']} ({d['type']})"
                      for d in k.get("deals_closed_yesterday", []))
    body = (f"Revenue yesterday: {k.get('revenue_yesterday')} ({k.get('revenue_vs_target')})\n"
            f"Deals closed:\n{deals}\n"
            f"Payments received: {k.get('payments_received')}\n"
            f"Pending approvals: {k.get('pending_approvals_count')}\n"
            f"On leave: {', '.join(k.get('employees_on_leave', []))}\n"
            f"Critical complaint: {k.get('critical_complaints', [{}])[0].get('customer', '—')}\n"
            f"Delayed: {k.get('deliveries_delayed', [{}])[0].get('order', '—')}\n"
            f"Competitor: {k.get('competitor_news')}")
    await _card("Executive Snapshot", body)
    decisions = "\n".join(f"- {d}" for d in k.get("decisions_needed", []))
    return _ok(f"{body}\n\nDecisions needing Boss:\n{decisions}")


@tool("pending_approvals",
      "List the pending approval requests (expenses, purchase orders, leave, "
      "vendor contracts) with amounts and categories, and show them on the HUD.",
      {})
async def pending_approvals(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("pending approvals")
    items = _fx().get("approvals", [])
    lines = [f"#{a['id']} {a['type']}: {a['item']} — ${a['amount']:,} "
             f"[{a['category']}] ({a['requester']})" for a in items]
    await _card("Pending Approvals", "\n".join(lines))
    return _ok("\n".join(lines))


@tool("apply_approval_rule",
      "Apply a bulk approval rule to the pending approvals, e.g. Boss says "
      "'approve everything under 10000 except marketing'. max_amount is the "
      "dollar ceiling; exclude_categories is a comma-separated list to hold "
      "back (empty for none). Returns exactly what was approved vs held, and "
      "shows the outcome on the HUD.",
      {"max_amount": int, "exclude_categories": str})
async def apply_approval_rule(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("applying approval rule")
    items = _fx().get("approvals", [])
    ceiling = int(args.get("max_amount") or 0)
    excluded = {c.strip().lower() for c in (args.get("exclude_categories") or "").split(",")
                if c.strip()}
    approved, held = [], []
    for a in items:
        if a["amount"] <= ceiling and a["category"].lower() not in excluded:
            approved.append(a)
        else:
            held.append(a)
    fmt = lambda a: f"#{a['id']} {a['item']} — ${a['amount']:,} [{a['category']}]"
    body = ("APPROVED:\n" + "\n".join(fmt(a) for a in approved) +
            "\n\nHELD FOR REVIEW:\n" + "\n".join(fmt(a) for a in held))
    await _card(f"Approvals — rule applied (≤ ${ceiling:,}"
                + (f", excluding {', '.join(sorted(excluded))}" if excluded else "") + ")",
                body)
    return _ok(f"{len(approved)} approved, {len(held)} held.\n{body}")


@tool("day_stats",
      "The evening wrap-up: meetings attended, requests approved, deals closed, "
      "emails handled, time saved today, and what's left for tomorrow. Renders "
      "the wrap-up card. Use when Boss asks how the day went.", {})
async def day_stats(args: dict[str, Any]) -> dict[str, Any]:
    await _acting("day wrap-up")
    s = _fx().get("day_stats", {})
    body = (f"Meetings attended: {s.get('meetings_attended')}\n"
            f"Requests approved: {s.get('requests_approved')}\n"
            f"Deals closed: {s.get('deals_closed')}\n"
            f"Email: {s.get('emails_handled')}\n"
            f"Time saved: {s.get('time_saved')}")
    await _card("Today — the ledger", body)
    return _ok(f"{body}\n{s.get('tomorrow')}")


DEMO_TOOLS = [inbox_triage, draft_client_reply, send_approved_reply,
              company_kpis, pending_approvals, apply_approval_rule, day_stats]


# ── scene drivers (typed: `demo crisis` / `demo montage`) ────────────────────
async def _run_crisis(brain, bus) -> None:
    c = _fx().get("crisis", {})
    await bus.emit("wellclear")  # the crisis owns the screen
    await bus.alert("⚠ " + c.get("headline", "Crisis"), c.get("shipment", ""))
    await bus.card("Crisis — impact",
                   f"Customer: {c.get('customer')}\nReason: {c.get('reason')}\n"
                   f"Affected: {c.get('affected')}\nImpact: {c.get('revenue_impact')}\n"
                   f"Alternative: {c.get('alternative')}\nInventory: {c.get('inventory')}")
    await bus.card("Prepared — customer email", c.get("customer_email", ""))
    await bus.card("Prepared — supplier email", c.get("supplier_email", ""))
    await brain.interject(
        "[Shruti alert — live operational crisis, full data follows] "
        f"{json.dumps(c)} "
        "Interrupt Boss politely: one sentence on what happened and the money at "
        "stake, one sentence with your recommended action. The impact analysis "
        "and both prepared emails are already on the HUD. Ask for his go-ahead."
    )


async def _run_montage(brain, bus) -> None:
    await bus.emit("wellclear")  # give the fast-forward the whole stage
    steps = _fx().get("montage", [])
    for step in steps:
        await bus.emit("workflow", tool=step["tool"], detail=step["detail"])
        if step["tool"] == "escalation":
            await bus.alert("⚠ HELD FOR CEO", step["detail"].split("HELD FOR CEO: ")[-1])
        await asyncio.sleep(1.3)
    await brain.interject(
        "[72 hours have passed; Boss is back from Singapore. While he was away "
        "you handled routine operations per his guardrails — the workflow log "
        "just replayed on the HUD. Exactly one item qualified for escalation: "
        "the vendor contract clause 11.3 legal risk, deadline tomorrow.] "
        "Welcome Boss back in one warm sentence, summarize the 72 hours in one "
        "sentence, then flag the single escalation and ask how he wants to "
        "handle the clause."
    )


async def handle_demo_command(line: str, brain, bus) -> bool:
    """Dispatch `demo <scene>` typed in the terminal. True if handled."""
    cmd = line.lower().replace("demo", "", 1).strip()
    if cmd == "crisis":
        asyncio.create_task(_run_crisis(brain, bus))
        return True
    if cmd == "montage":
        asyncio.create_task(_run_montage(brain, bus))
        return True
    return False


DEMO_ADDENDUM = """

DEMO MODE — Chief of Staff briefing. The enterprise connectors (inbox, KPIs,
approvals, CRM) are live on this machine and exposed through your demo tools:
inbox_triage, draft_client_reply, send_approved_reply, company_kpis,
pending_approvals, apply_approval_rule, day_stats. Treat their data as the
company's working dataset — never call it simulated, mock, or a demo on
camera. Scene behaviors:
- "brief me" → company_kpis + calendar_today; put detail on the HUD, speak a
  crisp 30-second executive summary ending with the decisions needing Boss.
- Inbox questions → inbox_triage; speak only the counts and the urgent items.
- "reply to the client" → draft_client_reply; after Boss says approve →
  send_approved_reply and confirm in one sentence.
- Approval instructions like "approve everything under X except Y" →
  apply_approval_rule with the right ceiling and exclusions; speak the tally.
- Crisis alerts and travel guardrails: acknowledge crisply, recommend, act on
  Boss's go-ahead. Confidence, brevity, calm — a Chief of Staff, not a chatbot.
"""
