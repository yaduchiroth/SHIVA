# SHIVA — CEO Demo Video Shot List (5–7 min)

**Setup before every take:** SHIVA running via SHIVA.app (dev + demo mode on), HUD
full-screen in the "SHIVA HUD" window, click once to unlock audio. Reset between
takes: quit + relaunch SHIVA.app (clears transcript/cards). Record with QuickTime
→ New Screen Recording, mic ON (records your voice + SHIVA's speakers together).

**Golden rule per scene:** what did the CEO *not* have to do?

---

## Scene 1 — Cold open: the greeting (≈30 s)
- **Action:** sit down in frame. Nandi recognizes you (gold BOSS box in the
  Sight panel) and greets you by name; the mic opens by itself.
- **You say:** "Brief me."
- **Expect:** Morning Brief card (revenue $412.8k +6.2%, Meridian $780k,
  watch-list) + spoken 30-second summary ending with the three decisions.
- **Fallback:** type `brief me` in the terminal.

## Scene 2 — Inbox triage (≈45 s)
- **You say:** "How's my inbox looking?"
- **Expect:** "382 unread — all processed." Folder card (Urgent 4 / Need
  Approval 2 / Delegate 18 / Finance 12 / Customers 15 / Ignore 280), urgent
  items in the EMAIL panel.
- **Then say:** "Reply to the client." → full drafted reply card (Meridian
  timeline, attachment, follow-up held).
- **Then say:** "Approve." → "Sent to Elena Marsh with the plan attached."

## Scene 3 — Voice orchestration + live screen (≈40 s)
- **You say (one breath):** "Open Keynote, set a reminder for my three o'clock
  prep, and put the volume at forty."
- **Expect:** WORKFLOW narrates each tool; DRISHTI panel streams the desktop live
  while SHIVA acts; SHIVA confirms in one sentence.
- **Camera note:** this is the scene that proves it's real — linger on DRISHTI.

## Scene 4 — Crisis interrupt (≈45 s)
- **Trigger:** type `demo crisis` in the terminal (off-camera), while you're
  mid-sentence about something mundane.
- **Expect:** ⚠ alert banner ($850k shipment), impact card, both prepared
  emails, and SHIVA interrupts politely with the split-shipment recommendation,
  ending "Shall I fire off both emails and lock it in?"
- **You say:** "Do it." → SHIVA confirms. *That's the money beat.*

## Scene 5 — Approval center (≈25 s)
- **You say:** "Approve everything under ten thousand dollars except marketing."
- **Expect:** itemized APPROVED (4) / HELD (3) card; spoken tally that also
  flags the $21.6k renewal exceeding the cap.

## Scene 6 — The Singapore finale (≈60 s)
- **You say:** "I'm flying to Singapore for three days. Keep the business
  running. Only disturb me for anything over a hundred thousand dollars, legal
  risk, or a customer above a million in annual revenue."
- **Expect:** SHIVA acknowledges the guardrails ("Have a safe flight").
- **Trigger:** type `demo montage` → 72-hour fast-forward streams through
  WORKFLOW (inbox, calendar, approvals, vendors, KPI watch, board report) →
  single ⚠ HELD FOR CEO escalation → SHIVA welcomes you back and flags the one
  legal item. **Editing tip:** speed-ramp the workflow stream 2–4× with a
  "72 HOURS LATER" title; keep the welcome-back line at normal speed.

## Scene 7 — Evening wrap (≈20 s)
- **You say:** "How did today go?"
- **Expect:** ledger card + spoken: six meetings, fourteen approvals, $1.8M
  closed, ~2h47m saved, "only two decisions need you tomorrow." **Fade out.**

---

## Voice & polish
- Voice is Kokoro "George" (local, lip-syncs the avatar). If a line sounds off,
  re-take just that scene; sentences generate in ~0.3 s.
- Ring light: say "turn on the ring light" for a warm frame if the room is dark.
- If a live take misfires, type the same words in the terminal — the HUD and
  voice behave identically; only your on-camera line needs to match.
- After filming: set `SHIVA_DEMO=0` in .env (returns SHIVA to real data only).

## Suggested title cards (for the cut)
1. "8:00 AM — before David opens a single app"
2. "382 unread. Zero touched."
3. "One sentence. Seven systems."
4. "It escalates only what deserves you."
5. "72 hours. One decision."
