# SHIVA's mind

SHIVA is two processes. The **face** is this repository's Next app — hand
tracking, the avatar, the AR surfaces, everything you look at. The **mind** is
`mind/`: Python, running Claude through the Agent SDK, with five dispatchable
companions, face recognition, memory, watchers and roughly forty tools.

It began life as a separate project called Odin, with a flat HTML HUD. The HUD is
gone — the spatial interface replaced it — and the agent has been renamed
throughout. Nothing was ported from Python to TypeScript; the two halves talk
over a WebSocket and always did.

---

## The pantheon

The subsystems are named for what they do, and the names are read by the model as
routing triggers and spoken out loud, so they were chosen to be apt rather than
decorative.

| Module       | What it does                                                     |
| ------------ | ---------------------------------------------------------------- |
| `nandi.py`   | Face recognition — Shiva's gatekeeper, who guards every entrance |
| `shruti.py`  | Watches what arrives — _that which is heard_                     |
| `smriti.py`  | Long-term memory — _that which is remembered_                    |
| `drishti.py` | Sees your screen — _sight_                                       |
| `vani.py`    | Voiceprints, who is speaking — _speech_                          |
| `kaala.py`   | Routines and schedules — _time_                                  |

Shruti and Smriti are a classical pair — revealed knowledge and remembered
knowledge — which is the same distinction, and the same relationship, that the
two ravens they replaced had.

**The Gana**, Shiva's attendants, are the five companions, named by role:

|                | Role                                                        |
| -------------- | ----------------------------------------------------------- |
| **Ganesha**    | Operations — logistics, chasing, anything with moving parts |
| **Lakshmi**    | Sales — deals, pipeline, revenue                            |
| **Narada**     | Marketing — campaigns, announcements, audience              |
| **Saraswati**  | Creative — writing, naming, taste                           |
| **Brihaspati** | Research — fact-finding, investigation                      |

Each is a markdown file in `mind/companions/`. Edit the brief, and SHIVA reloads
the roster without a restart.

---

## Running it

```bash
./mind/setup.sh     # once: Homebrew packages, Python env, Claude CLI
./shiva             # the mind and the face, together
```

`./shiva mind` and `./shiva face` start them separately. The interface is at
**http://localhost:3000**, and the HUD's `MIND` row says `Linked` within a second
or two.

They are separate processes on purpose: the mind holds a Claude session, a
microphone and a camera, and survives the interface being reloaded fifty times
while you work on it.

### First run after the rebrand

Three files hold things nothing can regenerate — the face SHIVA was enrolled
with, everything it has been asked to remember, and your voiceprint. They are
renamed automatically on the first run, and it says so:

```
[shiva] migrated heimdall.json → nandi.json
[shiva] migrated muninn.json → smriti.json
[shiva] migrated bragi.json → vani.json
```

The seventeen `ODIN_*` environment variables are now `SHIVA_*`. The old names
still work and are reported once at startup, so an existing `.env` does not
silently lose its configuration.

**The wake word is the one thing code cannot rename.** "Hey Odin" lives inside a
Picovoice `.ppn` binary. Until you generate a "Hey Shiva" keyword at
`console.picovoice.ai` and point `SHIVA_WAKE_PPN` at it, wake-word listening
falls back to the built-in keyword or push-to-talk — and says so rather than
leaving you wondering why it stopped answering to its name.

---

## The link

The mind's bus is a WebSocket on `127.0.0.1:8765`, and every event SHIVA
understands is transcribed in `src/adapters/mind/protocol.ts` from `mind/shiva/bus.py`
and its `bus.emit(...)` call sites.

| The mind emits                             | SHIVA does                                           |
| ------------------------------------------ | ---------------------------------------------------- |
| `state`                                    | drives the avatar's colour and energy                |
| `presence`                                 | greets you by name and lifts the lock screen         |
| `transcript`                               | appends to the conversation                          |
| `report`, `card`, `alert`                  | a surface on the wall                                |
| `chart`                                    | a plotted surface                                    |
| `webview`                                  | an embedded page                                     |
| `wellclear`                                | clears every surface                                 |
| `roster`                                   | companion orbs appear, coloured from their own files |
| `dispatch`, `companion`, `dispatch_return` | a beam runs out to a companion and back              |
| `devices`, `iot`                           | the connectors screen                                |
| `camera`, `screen`                         | a live feed surface                                  |
| anything else                              | logged as unhandled — the link stays up              |

Going the other way is one message: `{kind: 'text_input', text}`. When the link is
live, everything you type or say goes to Claude instead of Gemini —
`useBrain` routes on `mindLinked()`, so the typed console, the wake word and the
voice socket all follow the same rule.

**The reply does not come back from that call.** The mind answers asynchronously
over the bus, which is why `sendToMind` returns a boolean rather than a promise.

The mind also serves a small read API on `127.0.0.1:8377` — `/api/status`,
`/api/companions`, `/api/knowledge`, `/api/automations` — with CORS allowed for
`http://localhost:3000` and nothing else. It can write `.env` and relaunch the
process, so a wildcard there would let any page you happen to have open reach it.

---

## Away from the desk

A page served over HTTPS **cannot** open a `ws://127.0.0.1` socket — browsers
block mixed content, no retry fixes it, and the failure is silent. So SHIVA does
not try: the link checks the page's own protocol first and stays off, because a
reconnect loop against a rule that will never change is worse than nothing, and
reporting "not running" for a perfectly healthy mind would send you to restart
the wrong thing.

A hosted SHIVA therefore runs on Gemini with the same orb, the same gestures and
the same surfaces, and no companions. To reach the mind from one, put the bus
behind a TLS tunnel and set `NEXT_PUBLIC_SHIVA_WS` to its `wss://` address — a URL,
not a credential, which is why that prefix is correct here and nowhere else.

---

## What deliberately did not move

**The Claude brain stays on the Mac.** It authenticates through a Claude Code CLI
login, so hosting it would mean a completed interactive OAuth on a headless box —
and a Pro/Max subscription is licensed for interactive personal use, not as the
engine of a service. Reaching it over the bus gets the same capability with none
of that.

**The Mac-bound tools were not reimplemented.** `tools_mac`, `tools_devices`,
`tools_media`, `drishti`, `ears`, `sentinel` and `vani` drive AppleScript, local
audio hardware or the LAN. They work at the desk and nowhere else, which is a
property of the tools rather than a gap in the link.

---

## Working on it without a Mac

`?dev=1` exposes `window.__shiva`. `window.__shiva.mind({kind: 'report', …})`
feeds a raw wire message through the same parser and the same handler the socket
uses — everything downstream of the WebSocket, which is where the bugs are.
`window.__shiva.state()` reads back the phase, link and companion states that live
in stores only the WebGL scene reads.

`?surfaces=demo` seeds one of every screen type, `?mind=off` suppresses the
connection attempt, and `?lock=1` holds the lock screen open with no mind running.

`tests/mind.spec.ts` is the worked example.
