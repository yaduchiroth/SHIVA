# SHIVA

A futuristic personal agentic AI — industrial spatial computing interface.

> **Status: Phase 3 — live data.**
> The spatial shell, the Gemini brain, and real data behind the panels. System
> diagnostics and local weather are live with no credentials; weather drives the
> 3D environment's rain, fog and light. Projects reads GitHub with a token.
> Schedule, Markets and Reach declare themselves unconnected rather than
> inventing figures.

## Quick start

```bash
git clone -b claude/personal-agentic-ai-ny97hn https://github.com/yaduchiroth/SHIVA.git
cd SHIVA
npm install        # also vendors the MediaPipe WASM + hand landmarker model
npm run dev        # http://localhost:3000
```

Requires Node 20.9+. The spatial interface runs with no `.env.local` at all.
To enable the brain, add one key:

```bash
cp .env.example .env.local
# then set GEMINI_API_KEY — https://aistudio.google.com/apikey
```

Without it everything still runs; SHIVA simply reports that it has no key
rather than pretending to think.

Two things worth knowing on first run:

- **`npm install` downloads ~8 MB.** The `postinstall` step vendors the MediaPipe
  WASM out of `node_modules` and fetches the hand-landmarker model. If you're
  offline it warns and continues — the app still runs, just without hand
  tracking. Re-run `npm run assets` once you're back online.
- **The first load compiles shaders.** The boot sequence covers that window
  deliberately; it's the most expensive moment the app ever has.

### If something looks wrong

| Symptom                              | Cause                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Everything is a black rectangle      | WebGL unavailable or blocked. SHIVA detects this and says so instead of showing a blank page — check hardware acceleration is on. |
| Runs, but sluggish                   | The tier auto-selected too high. Force it down with `?quality=low`.                                                               |
| "Camera requires HTTPS or localhost" | You're on a plain LAN IP. `getUserMedia` refuses insecure origins — see below.                                                    |
| "Hand tracking model failed to load" | The `postinstall` download didn't complete. Run `npm run assets`.                                                                 |

### Hand tracking

Grant camera access when prompted. If you decline — or the camera is
unavailable, or the page isn't on a secure origin — SHIVA falls back to pointer
control and everything remains usable.

`getUserMedia` requires a secure context, which means `localhost` or HTTPS. On a
phone or tablet over your LAN you need HTTPS; plain `http://192.168.x.x` will
report the camera as unavailable.

### Controls

|         | Hand                           | Pointer              |
| ------- | ------------------------------ | -------------------- |
| Rotate  | Swipe                          | Drag, scroll, or ← → |
| Grab    | Pinch                          | Press and hold       |
| Expand  | Fist                           | Click, Enter         |
| Dismiss | Open palm                      | Escape               |
| Wake    | Trace a circle with one finger | `/` to type          |

### Talking to SHIVA

Three ways in, all equal:

- **Voice** — press **Voice**, then say "SHIVA, show me the markets". The wake
  phrase is required so the microphone can stay on without every remark in the
  room becoming a prompt. Chromium-based browsers only; Firefox has no
  `SpeechRecognition`.
- **Circle gesture** — point one finger and draw a circle in the air. Opens the
  input without touching anything.
- **Type** — press `/`.

SHIVA can drive the interface, not just describe it: "open projects", "next
panel", "close that", "drop the quality" all execute as tool calls. Commands go
through the same event bus your gestures do, so voice and hands can't drift
apart.

It also reads live data before answering: "how's my frame rate", "what's the
weather", "how many PRs are open" all call `read_module` and answer from the
same numbers the panel is showing, rather than from memory.

It will not invent data. Unconnected sources are declared as such in the system
prompt. Asked "what is my stock portfolio worth today?" it answers _"the markets
module is not connected yet, so I cannot retrieve your portfolio value"_ — that
is a real response from the live model, not an aspiration.

## Live data

| Module         | Source                                                              | Needs             |
| -------------- | ------------------------------------------------------------------- | ----------------- |
| System         | Measured in-browser: fps, frame time, renderer, heap, tracking rate | nothing           |
| Environment    | Open-Meteo, and it drives the 3D weather                            | nothing           |
| Projects       | GitHub GraphQL — open PRs, review requests, CI status               | `GITHUB_TOKEN`    |
| Schedule       | Google Calendar + Gmail                                             | not yet connected |
| Markets, Reach | —                                                                   | not yet connected |

**Weather changes the room.** Rain and snow fall as GPU particles, fog thickens
when it's foggy, the key light drops at night, and thunderstorms flash. It's the
actual weather where you are, not a theme picker.

Every panel shows one of four states and never blurs them: live data, a named
missing variable, the reason a fetch failed, or "not connected". An empty chart
would read as _zero_, which is the difference between an instrument and a
decoration.

### Verifying hand tracking

Add `?debug=hands` to see the tracking inspector: the mirrored camera feed with
the detected skeleton and the live pinch / grab / openness values. When a
gesture doesn't fire, this distinguishes the four possible causes — no camera
frames, no hand detected, wrong classification, or nothing listening — in about
two seconds.

## Commands

| Command             | Purpose                                     |
| ------------------- | ------------------------------------------- |
| `npm run dev`       | Development server                          |
| `npm run build`     | Production build                            |
| `npm run typecheck` | TypeScript, no emit                         |
| `npm run lint`      | ESLint                                      |
| `npm test`          | Playwright render, gesture and brain suites |
| `npm run assets`    | Re-fetch MediaPipe assets                   |

### Quality override

`?quality=low`, `?quality=medium` or `?quality=high` pins the render tier and
stops the runtime governor from moving it. Useful for checking how the interface
degrades without hunting for a slower machine. Without it, the tier is chosen
from device probing and adjusted at runtime from measured frame times.

## Architecture

```
app/                    routes, telemetry API, global design tokens
src/core/               store, config, typed event bus, hand frame buffer
src/spatial/            R3F stage, environment, carousel, physics, effects
src/spatial/hands/      MediaPipe loop, gesture recognizer, cursors
src/spatial/brain/      holographic particle text
src/hud/                boot sequence, HUD clusters, brain console, tracking inspector
src/brain/              brain client, speech recognition and synthesis
src/audio/              procedural Web Audio engine
src/adapters/brain/     Gemini client, tool definitions, system prompt
src/adapters/data/      Phase 3 seams (Calendar, Gmail, GitHub)
```

Three design decisions worth knowing before reading the code:

**State is split by update frequency.** Continuous hand data mutates a
singleton (`src/core/hands/handFrame.ts`) read inside the render loop; discrete
events and status live in Zustand. Routing 60 Hz tracking data through a store
with React subscribers would re-render the tree at tracking rate.

**All interaction goes through one event bus.** The gesture recognizer and the
pointer fallback publish the same events, so a mouse and a hand drive identical
downstream behaviour instead of two code paths that drift apart.

**Nothing fabricates data.** Readouts show real values or say plainly that they
can't. Panels whose data source arrives in a later phase are labelled as such on
their face, and the brain's system prompt names them as unconnected so the model
declines rather than invents.

**Gesture thresholds are measured, not guessed.** `tests/handPose.ts` generates
anatomically proportioned landmarks and `calibrate.spec.ts` prints what the
recognizer derives from each. Two gestures shipped broken in Phase 1 because the
thresholds were estimates; they're now derived from those numbers and asserted.

## Testing

`npm test` runs Playwright against a production build. The suite reads pixels
back off the canvas rather than only asserting on the DOM — the failure mode
worth catching is a WebGL app that mounts cleanly and renders a black rectangle.

CI has no GPU, so Chromium falls back to SwiftShader at well under one frame per
second on this scene. The suite distinguishes the two kinds of assertion:
correctness properties that hold at any speed are always checked, while
throughput assertions skip with a visible reason when there's no real GPU. See
`tests/helpers.ts`.

## Roadmap

Phase 3 connects real data behind Schedule, Projects, Markets and Reach — see
[`PHASE3.md`](./PHASE3.md).

## Deployment

See [`DEPLOY.md`](./DEPLOY.md) for Hostinger over git-pull — build sequence,
process management, and the three host requirements that fail silently rather
than loudly. Vercel also works out of the box via `vercel.json`.

The MediaPipe assets are gitignored and regenerated by `postinstall` at build
time, so nothing binary lives in the repo.
