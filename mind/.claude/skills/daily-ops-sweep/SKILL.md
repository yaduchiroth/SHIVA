---
name: daily-ops-sweep
description: Run the standing operations check — calendar, approvals, deliveries, complaints — and return what's on track, what's slipping and what needs Boss. Use for daily briefs, "what's the state of things", or any operational status request.
---

# Daily ops sweep

## Steps
1. Pull the real picture: `calendar_today`, `pending_approvals`, `company_kpis`.
   Never narrate from memory — read the current state.
2. Classify every item into exactly one bucket:
   - **NEEDS BOSS** — a decision only he can make, or money over his ceiling.
   - **SLIPPING** — has an owner, has a date, the date is at risk.
   - **ON TRACK** — no action required; compress these to a count, not a list.
3. For anything slipping, find the *blocker*, not just the status. "Waiting on
   legal" is a blocker; "in progress" is not.
4. Attach a cost to delay wherever a number exists — that's how Boss triages.

## Deliver
Speak: the count on track, then only the NEEDS BOSS items, in one line each.
HUD (`hud_report`): the full three-bucket table with owners and dates.

## Never
Never list green items aloud. Never report a status without an owner. Never let
an item that lapses today sit below one that lapses next week.
