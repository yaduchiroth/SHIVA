# SHIVA × ODIN

Odin is the mind: a Python process on your Mac running Claude through the Agent
SDK, with five dispatchable companions, face recognition, memory, watchers and
roughly forty tools. SHIVA is the face: hand tracking, a spatial renderer, an
avatar, and screens you can reach out and touch.

They are two repositories and one protocol. Odin keeps everything it can do;
SHIVA replaces the flat HTML HUD it used to draw into. Nothing was ported from
Python to TypeScript — Odin's `hud/` directory is simply no longer the thing you
look at.

---

## The link

Odin's bus is a WebSocket on `127.0.0.1:8765`, and every event SHIVA understands
is transcribed in `src/adapters/odin/protocol.ts` from `odin/bus.py` and its
`bus.emit(...)` call sites.

| Odin emits                                 | SHIVA does                                           |
| ------------------------------------------ | ---------------------------------------------------- |
| `state`                                    | drives the avatar's colour and energy                |
| `transcript`                               | appends to the conversation                          |
| `report`, `card`, `raven`                  | a surface on the wall                                |
| `chart`                                    | a plotted surface                                    |
| `webview`                                  | an embedded page                                     |
| `wellclear`                                | clears every surface                                 |
| `roster`                                   | companion orbs appear, coloured from their own files |
| `dispatch`, `companion`, `dispatch_return` | a beam runs out to a companion and back              |
| `devices`, `iot`                           | the connectors screen                                |
| `camera`, `screen`                         | a live feed surface                                  |
| `presence`                                 | the avatar reacts to someone arriving                |
| anything else                              | logged as unhandled — the link stays up              |

Going the other way is one message: `{kind: 'text_input', text}`, which is
Odin's own inbound protocol. When the link is live, everything you type or say
goes to Claude instead of Gemini — `useBrain` routes on `odinLinked()`, so the
typed console, the wake word and the voice socket all follow the same rule.

**The reply does not come back from that call.** Odin answers asynchronously
over the bus. That asymmetry is the protocol's, and it is why `sendToOdin`
returns a boolean rather than a promise.

---

## Running it

On the Mac, in the Odin checkout:

```bash
python -m odin
```

Then SHIVA, in this one:

```bash
npm run dev
```

Open **http://localhost:3000**. The HUD's `ODIN` row says `Linked` within a
second or two. If it says `Not running`, Odin is not up or is on a different
port.

That is the whole setup. There is no configuration, because the default is the
only address Odin binds to.

---

## Why the hosted deployment cannot reach Odin

`https://shiva.drottnatech.com` **cannot** open `ws://127.0.0.1:8765`. Browsers
refuse an insecure socket from a secure page, it is not something a retry fixes,
and the failure is silent. So SHIVA does not try: `useOdinLink` checks the page's
own protocol first and stays off, because a reconnect loop against a rule that
will never change is worse than nothing, and reporting `Not running` for a
perfectly healthy Odin would send you to restart the wrong thing.

Three consequences worth being clear about:

- **Hosted SHIVA runs on Gemini.** Same build, same orb, same gestures, same
  surfaces. A different brain answers, and the Mac-bound tools are absent.
- **The desk runs on Claude**, with the companions and everything Odin can
  reach.
- **To have both**, put the bus behind a TLS tunnel — Cloudflare Tunnel or
  Tailscale Funnel — and set `NEXT_PUBLIC_ODIN_WS` to its `wss://` address. It
  is a URL, not a credential, so `NEXT_PUBLIC_` is correct here and nowhere else
  in this project.

The spatial layer is identical in all three cases. Hand tracking and rendering
are entirely browser-side; only what answers behind the brain differs.

---

## What was deliberately not done

**Odin's Claude brain was not moved to the server.** It authenticates through a
Claude Code CLI login, which would mean a completed interactive OAuth on a
headless shared box — and a Pro/Max subscription is licensed for interactive
personal use, not as the engine of a hosted service. Keeping it on the Mac and
reaching it over the bus gets the same capability with none of that.

**Odin's Mac-bound tools were not reimplemented.** `tools_mac`, `tools_devices`,
`tools_media`, `mimir`, `ears`, `sentinel` and `bragi` all drive AppleScript,
local audio hardware or the LAN. They work at the desk and nowhere else, which
is a property of the tools rather than a gap in the link.

---

## Working on it without a Mac

`?dev=1` exposes `window.__shiva`. `window.__shiva.odin({kind: 'report', …})`
feeds a raw wire message through the same parser and the same handler the socket
uses — everything downstream of the WebSocket, which is where the bugs are.
`window.__shiva.state()` reads back the phase, link and companion states that
live in stores only the WebGL scene reads.

`?surfaces=demo` seeds one of every screen type. `?odin=off` suppresses the
connection attempt entirely.

The test suite uses all three; `tests/odin.spec.ts` is the worked example.
