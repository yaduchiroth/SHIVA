# SHIVA — complete build reference, written for extraction

> **This document answered a question that has since been settled differently.**
>
> It was written to help lift SHIVA's input and presentation layer into an AI
> you already had. That AI turned out to be Odin, and the merge went the other
> way: Odin keeps its Python brain and tools, and SHIVA became its interface
> over Odin's own WebSocket bus. Nothing was extracted. See **[ODIN.md](ODIN.md)**
> for how the two now fit together.
>
> What follows is still accurate about SHIVA's internals, and still the right
> document if you ever want to take the hand-tracking layer somewhere else.
> The event bus it names as the seam is the same one the Odin link publishes
> into, so the description of that seam holds exactly.

Everything built so far, organised around one question: **what do you lift out of
here to give an AI you already have a spatial interface and real hand gestures,
and what do you leave behind?**

Your existing AI already has a brain. So the valuable half of SHIVA for you is
the _input and presentation_ layer — hand tracking, gesture recognition, the 3D
stage — and the seam that lets a brain drive it. That seam is a typed event bus
with eleven events. If your AI can call `emit('carousel:step', {direction: 1})`,
it can drive this interface, and it does not need to know anything else about it.

Total: **10,706 lines** across 78 files (excluding config). Of that, ~1,965 lines
are the portable input layer — filters, tracking, gesture engine, interaction
policy — and another ~2,330 are the 3D stage if you want the look too. The rest
is SHIVA's own brain, data sources and chrome.

---

## Contents

1. [The thirty-second version](#1-the-thirty-second-version)
2. [Extraction map — what to take](#2-extraction-map--what-to-take)
3. [The integration seam](#3-the-integration-seam)
4. [Hand tracking, end to end](#4-hand-tracking-end-to-end)
5. [Gesture recognition and its calibrated numbers](#5-gesture-recognition-and-its-calibrated-numbers)
6. [The spatial renderer](#6-the-spatial-renderer)
7. [State architecture — the one rule that matters](#7-state-architecture--the-one-rule-that-matters)
8. [The brain layer (SHIVA-specific — probably replace)](#8-the-brain-layer-shiva-specific--probably-replace)
9. [Voice](#9-voice)
10. [Live data](#10-live-data)
11. [Build, assets and the COEP requirement](#11-build-assets-and-the-coep-requirement)
12. [Tests](#12-tests)
13. [Bugs already paid for — do not rediscover these](#13-bugs-already-paid-for--do-not-rediscover-these)
14. [Three merge strategies, with trade-offs](#14-three-merge-strategies-with-trade-offs)
15. [Complete file inventory](#15-complete-file-inventory)

---

## 1. The thirty-second version

```
webcam ──► MediaPipe HandLandmarker ──► HandRecognizer ──┬──► handFrame (mutable singleton, 60Hz)
           (21 landmarks, GPU/WASM)     (One Euro filter  │      read in useFrame — no React
                                         + Schmitt gates) │
                                                          └──► event bus (discrete events)
                                                                     │
                            pointer/keyboard fallback ──────────────►┤
                                                                     │
                            your AI's tool calls ──────────────────► ┤
                                                                     ▼
                                                          useInteractionDriver
                                                          (all policy lives here)
                                                                     ▼
                                                          Zustand stores ──► R3F scene
```

Four properties this design buys, which are the reason it's worth lifting rather
than rewriting:

- **Hands, mouse and AI are the same input.** All three publish identical events.
  There is no "hand path" and "mouse path" to drift apart.
- **Tracking never touches React.** Continuous 60Hz data mutates a plain object
  read inside the render loop. Only discrete events reach the store.
- **Gesture policy is in exactly one file.** The recognizer knows hand shapes and
  nothing about your UI; the UI knows nothing about hands. `useInteractionDriver`
  is the only place that says what a pinch _means_.
- **Every threshold is measured, not guessed.** `tests/calibrate.spec.ts` prints
  the ratios for anatomically-proportioned poses so you can retune against data.

---

## 2. Extraction map — what to take

### Tier 1 — pure, zero dependencies, copy as-is

| File                  | Lines | What it is                                                      |
| --------------------- | ----- | --------------------------------------------------------------- |
| `src/lib/one-euro.ts` | 115   | One Euro adaptive filter (Casiez et al., CHI 2012)              |
| `src/lib/math.ts`     | 73    | `clamp`, `damp` (framerate-independent), `dampAngle`, `Schmitt` |
| `src/lib/sse.ts`      | 68    | SSE framer that handles CRLF and the final frame                |
| `src/lib/pcm.ts`      | 76    | Float32↔int16 PCM and resampling for streamed voice            |
| `src/core/types.ts`   | 77    | `HandState`, `Vec3`, `GestureName`, `TrackingStatus`            |

No imports outside themselves. `one-euro.ts` and `math.ts` are the whole reason
tracking feels solid rather than jittery — take them first.

### Tier 2 — the gesture engine, depends only on Tier 1

| File                                     | Lines | Notes                                            |
| ---------------------------------------- | ----- | ------------------------------------------------ |
| `src/core/events/bus.ts`                 | 69    | Typed pub/sub. Trim `EventMap` to your events.   |
| `src/core/hands/handFrame.ts`            | 81    | The mutable 60Hz singleton                       |
| `src/spatial/hands/videoSource.ts`       | 20    | Module slot holding the `<video>` element        |
| `src/spatial/hands/gestureRecognizer.ts` | 398   | **The core asset.** 21 landmarks → gestures      |
| `src/spatial/hands/useHandTracking.ts`   | 278   | Camera + MediaPipe + rAF loop                    |
| `src/spatial/hands/projection.ts`        | 43    | Normalised tracking space → three.js world space |
| `scripts/fetch-assets.mjs`               | 89    | Vendors WASM + downloads the model               |

This block is **self-contained hand tracking**. Its only external couplings are
`useGestureStore` and `useSystemStore` (for status display and the tracking-rate
cap) — swap those for your own state in about twenty lines. `projection.ts` needs
three.js; drop it if you're not rendering in 3D.

Together: ~1,000 lines that turn a webcam into reliable gestures.

### Tier 3 — interaction policy, rewrite the rules but keep the structure

| File                                        | Lines | Notes                                                                  |
| ------------------------------------------- | ----- | ---------------------------------------------------------------------- |
| `src/spatial/hands/useInteractionDriver.ts` | 332   | Gesture→meaning mapping, **plus** the whole pointer/keyboard fallback  |
| `src/spatial/hands/HandCursors.tsx`         | 179   | 3D cursors with motion trails                                          |
| `src/hud/HandDebugOverlay.tsx`              | 143   | Live skeleton overlay (`?debug=hands`) — keep this, it pays for itself |

The _rules_ here are SHIVA's (pinch grabs a panel, fist focuses, palm dismisses).
The _shape_ is worth keeping: one file, both input modes converging, plus two
watchdogs that stop stuck states.

### Tier 4 — the 3D stage, take if you want the look

| File                                  | Lines |
| ------------------------------------- | ----- |
| `src/spatial/Stage.tsx`               | 90    |
| `src/spatial/CameraRig.tsx`           | 82    |
| `src/spatial/PerformanceGovernor.tsx` | 107   |
| `src/spatial/carousel/*`              | 933   |
| `src/spatial/environment/*`           | 870   |
| `src/spatial/effects/EffectStack.tsx` | 134   |
| `src/core/config/quality.ts`          | 71    |
| `src/core/config/palette.ts`          | 44    |

Requires React Three Fiber, drei, postprocessing. Heaviest dependency block. See
§6 for what each piece does and §13 for the traps.

### Tier 5 — SHIVA-specific, you probably already have equivalents

`src/adapters/brain/*`, `src/brain/*`, `src/adapters/data/*`, `src/data/*`,
`app/api/*`, `src/hud/Hud.tsx`, `src/hud/BootSequence.tsx`,
`src/core/config/modules.ts`.

Read `src/adapters/brain/commands.ts` even if you discard it — the tool schemas
are the vocabulary your AI needs to drive the interface (§3).

---

## 3. The integration seam

**`src/core/events/bus.ts` is the entire contract.** Anything that can emit these
events can drive the spatial layer.

```ts
export interface EventMap {
  'gesture:start': { hand: Handedness; gesture: GestureName; position: Vec3 }
  'gesture:end': { hand: Handedness; gesture: GestureName; position: Vec3 }
  'gesture:swipe': { hand: Handedness; direction: -1 | 1; speed: number }
  'panel:grab': { index: number; hand: Handedness }
  'panel:release': { index: number; velocity: Vec3 }
  'panel:focus': { index: number }
  'panel:blur': { index: number }
  'carousel:step': { direction: -1 | 1 }
  'ui:confirm': { intensity: number }
  'tracking:acquired': { hands: number }
  'tracking:lost': Record<string, never>
  'brain:wake': { hand: Handedness }
}
```

API is three functions: `on(event, handler) => unsubscribe`, `emit(event, payload)`,
`clearBus()`. Handlers are wrapped in try/catch individually — one listener
throwing must not freeze the carousel.

### Wiring your existing AI to it

SHIVA's brain drives the UI through five tool definitions in
`src/adapters/brain/commands.ts`. Give these to your model and implement the
dispatcher (SHIVA's is `executeTool()` in `src/brain/useBrain.ts`):

| Tool              | Args                              | Effect                                   |
| ----------------- | --------------------------------- | ---------------------------------------- |
| `focus_module`    | `{module: ModuleId}`              | Rotate to it and expand it               |
| `rotate_carousel` | `{direction: 'next'\|'previous'}` | One step                                 |
| `dismiss`         | `{}`                              | Collapse focus                           |
| `read_module`     | `{module: ModuleId}`              | Return that panel's live readout as text |
| `set_quality`     | `{tier: 'low'\|'medium'\|'high'}` | Change the render budget                 |

Two details worth copying:

- **Rotation takes the shortest path.** The carousel index is unbounded (it keeps
  counting past the module list and wraps by modulo when read), so rotating from
  panel 5 to panel 0 goes forward one step, not backward five.
- **`read_module` returns real state or an explicit "not connected".** The system
  prompt derives, at build time, which modules are live and which aren't, and
  instructs the model to say "not connected" rather than invent a plausible
  number. This is the single most important line in the prompt: an assistant that
  invents your calendar is worse than one that admits it can't see it.

### The reverse direction

Your AI probably wants to _know_ when the user acts. Subscribe:

```ts
import { on } from './core/events/bus'

on('panel:focus', ({ index }) => yourAI.notice(`user opened ${MODULES[index].id}`))
on('brain:wake',  () => yourAI.startListening())   // user traced a circle in the air
on('gesture:swipe', ({ direction }) => …)
```

`brain:wake` is the gestural equivalent of a wake word — fire your listener from it.

---

## 4. Hand tracking, end to end

### Model and runtime

MediaPipe Tasks Vision `1.0.1`, `HandLandmarker`, float16 `hand_landmarker.task`
(~7.8 MB), GPU delegate, `runningMode: 'VIDEO'`, `numHands: 2`.

```ts
minHandDetectionConfidence: 0.5,
minHandPresenceConfidence: 0.5,
minTrackingConfidence: 0.6,   // higher than detection on purpose:
                              // once found, keeping the track stable matters
                              // more than re-acquiring aggressively
```

Camera constraints: `640×480`, `facingMode: 'user'`, `frameRate: {ideal: 30, max: 30}`.
Inference is the bottleneck, not capture — 1080p costs decode time and buys nothing.

The `<video>` element is created with `document.createElement` and **never
attached to the DOM**. It exists purely as a frame source. Anything that wants to
show the feed must draw it (the debug overlay does).

### The loop, and four non-obvious guards

It runs on its **own `requestAnimationFrame`, deliberately not inside R3F's
`useFrame`**. Inference costs 8–20 ms; putting it in the render loop adds that to
every frame's budget. Independent loops mean the renderer samples whatever the
latest result happens to be.

```ts
// 1. Skip frames the camera hasn't refreshed.
//    A 30fps feed on a 120Hz display would otherwise infer 4× per new frame.
if (el.currentTime === lastVideoTime.current) return
lastVideoTime.current = el.currentTime

// 2. Honour the tier's inference ceiling (low 20Hz / medium 30 / high 60).
if (now - lastInference.current < 1000 / trackingHz - 1) return

// 3. MediaPipe throws on a repeated timestamp. Always pass a strictly
//    increasing value — performance.now() is fine.
result = model.detectForVideo(el, now)

// 4. Handedness labels are from the CAMERA's point of view, and the feed is
//    mirrored for the user, so they must be swapped.
const handedness = label === 'Left' ? 'right' : 'left'
```

**Two separate clocks.** `lastInference` paces inference; `lastReport` paces store
writes (~4Hz, because the HUD is the only consumer and can't show more). Sharing
one ref makes each reset the other's window — that was a real bug.

### Handing control back

```ts
const HANDS_ABSENT_MS = 2500
```

Hands up → hands drive. Hands gone for 2.5 s → the pointer gets control back.
Without this, tracking stays authoritative forever once started, so a user who
steps away is left with an interface responding to neither hands nor mouse.
Tracking keeps running; only _who is allowed to drive_ changes.

### Coordinate projection

`projection.ts` reconciles three conventions:

1. **Y is inverted** — video counts down, world counts up.
2. **X is mirrored** — the feed is shown mirrored (an un-mirrored self-view feels
   broken), so a hand moving to the user's right is `-x` in tracking space.
3. **Landmarks are 2D-ish** — MediaPipe's `z` is relative and noisy. It's used
   only as a small parallax nudge (`clamp(z, -0.35, 0.35) * 4`), never as absolute
   depth. Points are unprojected onto a plane at a fixed distance instead.

`NDC_RANGE = 1.6` gives slight overscan so tracking reaches past the frame edge.

---

## 5. Gesture recognition and its calibrated numbers

`src/spatial/hands/gestureRecognizer.ts` — 398 lines, the single most valuable
file here. Three principles make it reliable rather than a demo that works once:

**1. Scale normalisation.** Every distance is divided by the hand's own size
(`wrist → middle-knuckle`, floored at `0.02` to survive a degenerate hand at the
frame edge). A raw threshold in normalised video units only works at one distance
from the camera; divide it out and the same gesture registers near or far.

**2. Hysteresis.** Enter and exit on different thresholds, so a signal hovering at
the boundary can't strobe. `Schmitt` in `src/lib/math.ts` handles both polarities
— `enter < exit` means "triggers on the way down" (pinch distance), otherwise "on
the way up" (finger count).

**3. Filter before thresholding.** Positions go through One Euro _first_, so
jitter can't trip a gate on one bad frame.

### The measured constants

```ts
const EXTENDED = 1.7 // fingertip→wrist, in palm widths: finger is straight
const CURLED = 1.35 // …folded

// The gap is a deliberate DEAD ZONE. A hand hanging naturally lands inside it,
// so no gesture fires — which is what stops the interface reacting to someone
// who is simply resting. ~20% margin either side of a relaxed hand.
```

```ts
pinchGate = new Schmitt(0.32, 0.45) // thumb→index over palm scale
// real pinch ≈ 0.03; nearest non-pinch
// pose (a point) ≈ 1.30 — wide margin
grabGate = new Schmitt(2.5, 1.5) // on a finger-COUNT score, not a ratio
palmGate = new Schmitt(2.5, 1.5) // ≥3 of 4 fingers extended
```

**Why counts, not aggregate ratios.** The first version gated on mean curl. That
demands a real hand match a specific numeric profile, and hands vary enormously —
finger length, how far someone actually straightens, camera distance. A real fist
measured 0.88 against a gate set at 0.55, so **the grab gesture literally could
never fire**. Counting fingers is robust to all of it, because each finger only
has to land clearly on one side of a wide dead zone.

Three-of-four for both grab and palm is deliberate. Requiring all four means one
stiff pinky, or one badly-placed fingertip, silently kills the gesture — which is
exactly what _"it doesn't follow my gestures"_ feels like from the outside.

### The closedness score

Counting folds alone classified a **point** as a **grab** — pointing folds three
fingers too. A fist is not "several fingers folded", it's "nothing sticking out":

```ts
const closedness = curledCount - extendedCount * 2
// fist  → 4 - 0 = 4
// point → 3 - 2 = 1
// gate sits at 2.5 / 1.5, between them
const grabRatio = this.grabFilter.filter(closedness, timestamp)
const grabbing = this.grabGate.update(grabRatio)
```

### Resolution priority

```ts
pinch → grab → point → palm → idle
```

Pinch is a subset of many hand shapes, so it must be tested first or it never wins.

### Filter tuning

```ts
palmFilter = new OneEuroVec3({ minCutoff: 1.0, beta: 0.02 }) // steady
tipFilter = new OneEuroVec3({ minCutoff: 1.6, beta: 0.03 }) // responsive
pinchFilter = new OneEuroFilter({ minCutoff: 2.4, beta: 0.01 }) // fast: pinch is
// deliberate and
// quick
grabFilter = new OneEuroFilter({ minCutoff: 2.0, beta: 0.01 })
```

Palm centre is the **centroid of wrist + three knuckles**, not the wrist alone —
the wrist swings widely as the hand rotates.

### Swipe

```ts
palmOpen && !pinching && !grabbing
  && |vx| > 0.9 && |vx| > |vy| * 1.8
  → emit('gesture:swipe', { direction: vx > 0 ? -1 : 1, speed: |vx| })
cooldown = 0.55s
```

Requiring an open palm is what stops a fast grab-and-move from also registering as
a swipe. Direction is negated because x is mirrored on screen.

### Circle-to-wake

Traced circle = gestural wake word. It accumulates the **signed** angle swept
around the path's centroid:

```ts
if (delta > Math.PI) delta -= Math.PI * 2 // unwrap the ±π seam,
if (delta < -Math.PI) delta += Math.PI * 2 // or every lap cancels itself out
swept += delta
return Math.abs(swept) > Math.PI * 1.7 // ~85% of a turn — demanding a full
// 2π rejects the loops people
// actually draw
```

Signed is the crucial part: a back-and-forth wave sweeps a large _total_ angle but
nets to ~zero, whereas a real loop accumulates in one direction. Summing absolute
angles fires on any vigorous movement.

Two shape guards: `meanRadius ≥ 0.045` (below that it's smaller than the jitter),
and radii must cluster (`radiusMin ≥ mean*0.35`, `radiusMax ≤ mean*2.2`) so a long
thin scribble is rejected. Tracked **only while pointing**, on a 1.6 s time-bounded
window (time, not sample count — so it means the same thing at 20Hz and 60Hz),
with a 2 s cooldown.

### `reset()` must emit `gesture:end`

```ts
reset(): void {
  if (this.activeGesture !== 'idle') {
    emit('gesture:end', { hand: this.handedness, gesture: this.activeGesture,
                          position: { ...this.lastPosition } })
  }
  …clear every filter and gate…
}
```

**This is not optional.** MediaPipe drops detection constantly — a hand moving
fast, turning edge-on, or crossing a shadow vanishes for a frame or two. Without
this, a pinch that started before the dropout never ends: the panel stays grabbed
forever, and because input mode is still `'hand'`, the pointer can't rescue you
either. That is the entire "won't leave grab mode" failure, and it will happen to
you too if you skip this.

Belt and braces on top, in `useInteractionDriver`: a 400 ms watchdog that releases
anything grabbed while no hand is visible. The cost of being wrong is asymmetric —
a spurious release is a minor annoyance, a stuck grab makes the interface unusable.

---

## 6. The spatial renderer

Stack: React Three Fiber 9.7.0 · three 0.185.1 · drei 10.7.8 · postprocessing
6.39.4 · @react-three/rapier 2.2.0.

### Canvas setup (`Stage.tsx`)

```ts
gl.toneMapping = THREE.ACESFilmicToneMapping // makes emissive highlights roll
gl.toneMappingExposure = 1.15 // off instead of clipping to flat
gl.outputColorSpace = THREE.SRGBColorSpace // white — essential for glass+bloom
antialias: false // the composer's multisampling handles it; both is waste
alpha: false
preserveDrawingBuffer: capture // opt-in via ?capture=1 — it blocks a driver
// optimisation and costs real frames
```

Camera: `position [0, 0.6, 9.5]`, `fov 42`, `near 0.1`, `far 120`.

### Quality tiers

`src/core/config/quality.ts` — every expensive feature is data, not hard-coded in
components, so degrading is a config change rather than a hunt through the scene
graph.

|                         | low    | medium  | high   |
| ----------------------- | ------ | ------- | ------ |
| dpr                     | 0.6–1  | 0.8–1.5 | 1–2    |
| bloom                   | ✓      | ✓       | ✓      |
| god rays                | ✗      | ✗       | ✓      |
| depth of field          | ✗      | ✓       | ✓      |
| chromatic aberration    | ✗      | ✓       | ✓      |
| transmission samples    | 2      | 4       | 8      |
| transmission resolution | 128    | 256     | 512    |
| particles               | 600    | 1,800   | 4,000  |
| shadows                 | ✗      | ✗       | ✓      |
| **tracking Hz**         | **20** | **30**  | **60** |

Bloom survives even at low: it's the last effect worth cutting, because without it
nothing glows and the aesthetic collapses.

Tier is chosen by `getDeviceProfile()` (`src/lib/device.ts`) from the WebGL
renderer string, mobile detection, core count and `deviceMemory`. SwiftShader /
llvmpipe / "software" force low. `?quality=low|medium|high` pins it and stops the
runtime governor overriding — used by the test suite to hold quality constant.

The probe **releases its WebGL context immediately** via `WEBGL_lose_context`.
Browsers cap concurrent contexts (often 16) and a leaked probe context can starve
the real canvas.

`PerformanceGovernor.tsx` watches frame time and steps the tier down (never up
past a pinned value).

### Glass panels

`MeshTransmissionMaterial` with **`transmissionSampler` enabled** so panels share
three's single transmission pass. Without it each mesh gets its own FBO — six
panels means six extra full scene renders per frame.

Panel geometry is `ExtrudeGeometry`. Content and edge planes are positioned from
the **measured bounding box**, not from the nominal depth (§13).

Panel faces are Canvas2D textures (`panelTexture.ts`), repainted only when the
readout signature changes, at most every 0.25 s.

### Environment

- `StudioEnvironment.tsx` — procedural **float equirect texture → PMREMGenerator**.
  No CDN HDR. This exists because transmission materials refract the environment
  map; with no envmap, glass renders **invisible**.
- `Environment.tsx` — an `ATMOSPHERE` record per sky state
  (`clear|cloudy|fog|rain|snow|storm`) with damped transitions and storm lightning.
- `Particulate.tsx` / `Precipitation.tsx` — **GPU-only motion**: positions are
  closed-form functions of time in the vertex shader, using `fract()` for
  wrapping. Never per-frame JS buffer writes.
- `VolumetricFog.tsx`, `InfiniteGrid.tsx`, `LightSource.tsx` (the god-ray occluder).

### Colour

`src/core/config/palette.ts` holds literal colour values plus `resolveColor()`.
CSS custom properties are the source of truth for DOM chrome, but Canvas2D and
three.js can't read CSS vars — hence the literals.

---

## 7. State architecture — the one rule that matters

> **Continuous values in a mutable singleton. Events and status in the store.**

Hand tracking produces a new pose 30–60 times a second. Routing that through
Zustand re-renders the React tree at tracking rate and destroys the frame budget
you're trying to protect. So:

```ts
// src/core/hands/handFrame.ts — mutated in place, NEVER reassigned
export const handFrame: HandFrame = {
  left: emptyHand('left'),
  right: emptyHand('right'),
  count: 0,
  timestamp: 0,
  inferenceMs: 0,
}
export const getPrimaryHand = (): HandState | null =>
  handFrame.right.visible ? handFrame.right : handFrame.left.visible ? handFrame.left : null
```

Consumers read it inside `useFrame`. The render loop already runs every frame, so
sampling there is free.

The `landmarks: Vec3[]` array on each hand is copied **field by field**, never
reassigned, so the debug overlay's held reference stays valid.

### The five stores (Zustand 5)

| Store             | Holds                                                                           |
| ----------------- | ------------------------------------------------------------------------------- |
| `useSystemStore`  | boot phase, quality tier, fps, telemetry, `pinned`                              |
| `useGestureStore` | tracking status, `inputMode: 'hand'\|'pointer'`, per-hand gesture, inference ms |
| `useSpatialStore` | carousel `index` (unbounded, wraps on read), `focused`, `grabbed`, idle         |
| `useBrainStore`   | phase, messages, streaming buffer, transcript                                   |
| `useDataStore`    | per-source `SourceState` unions                                                 |

`activeModuleIndex(index)` does the modulo. Keeping the raw index unbounded is what
makes continuous drag-rotation and shortest-path AI rotation both work.

---

## 8. The brain layer (SHIVA-specific — probably replace)

You already have this, so this section is mostly here so you can decide what to
keep. Two pieces are worth reading regardless.

### The provider-neutral contract (`src/adapters/brain/types.ts`)

```ts
export interface Brain {
  readonly id: string
  readonly model: string
  stream(request: BrainRequest): AsyncIterable<BrainEvent>
}

export type BrainEvent =
  | { type: 'text'; delta: string }
  | {
      type: 'tool-call'
      id: string
      name: string
      args: Record<string, unknown>
      thoughtSignature?: string
    }
  | { type: 'tool-result'; id: string; result: unknown }
  | { type: 'done'; reason: 'stop' | 'length' | 'tool' }
  | { type: 'error'; message: string }
```

Async iteration rather than callbacks, so backpressure and cancellation work
naturally — the UI stops consuming and the request aborts.

**If your AI implements this three-property interface, it drops straight into
SHIVA's UI with no other changes.** That is the cheapest possible merge in the
"keep SHIVA's shell" direction.

### The Gemini adapter (`src/adapters/brain/gemini.ts`, 339 lines)

Worth reading for what it survived, not for Gemini specifically:

```ts
const RETRYABLE = new Set([429, 503, 500, 502, 504])
const MAX_ATTEMPTS = 2
const BACKOFF_MS = 600
const FALLBACK_MODELS = ['gemini-flash-lite-latest', 'gemini-3-flash-preview']
readonly model = process.env.GEMINI_MODEL ?? 'gemini-flash-latest'
```

An outer labelled loop walks `[model, ...fallbacks]`; an inner loop retries with
backoff. It tracks **both** `sawText` and `sawToolCall` — an early version
reported "empty response" for a turn that consisted solely of a tool call.

`toContents()` maps a `role: 'tool'` message into a `model` turn carrying
`functionCall` plus a `user` turn carrying `functionResponse`, propagating
`thoughtSignature` (Gemini 3 rejects a function-response turn that drops it).

Also handles `promptFeedback.blockReason`, and pins to model **aliases** rather
than dated IDs — `gemini-2.5-flash` now 404s for newly-issued keys.

### Key handling

`GEMINI_API_KEY` is server-side only, read in `app/api/brain/route.ts` and
`app/api/speech/route.ts` (both edge runtime). **Never** `NEXT_PUBLIC_`. If you
carry any of this over, keep that rule — a `NEXT_PUBLIC_` prefix ships the key in
the client bundle to every visitor.

---

## 9. Voice

There are two voice paths, and they are different things rather than one being a
worse version of the other.

### Live agent — `src/brain/useVoiceAgent.ts` (445) + `src/adapters/voice/deepgram.ts` (214)

One websocket. Microphone audio streams up continuously, agent audio streams
down, and the agent decides when to talk. The property that matters is
**interruption**: the moment the service reports `UserStartedSpeaking`, every
scheduled output buffer is stopped mid-word. Turn-based voice structurally
cannot do this — by the time you hear a reply it has already been synthesised in
full.

Worth lifting if you want live voice anywhere:

- `src/lib/pcm.ts` — `floatToInt16` / `int16ToFloat` / `resample`. Pure and
  tested. Every bug here produces _audio_ rather than an error, which is why it
  is isolated: a sign flip is noise, a scale error is a click, a missed resample
  is speech at half speed that transcribes as gibberish.
- The **inline AudioWorklet** (a Blob URL, so it loads under COEP where a CDN
  worklet would not) that batches 128-frame quanta into chunks — posting every
  quantum is ~375 `postMessage` calls a second.
- The **playback cursor** pattern: schedule each buffer at
  `max(cursor, currentTime + lead)` and keep every source in a Set so barge-in
  can stop them all.
- `describeClose()` — a websocket rejected on a bad field closes with `1008` and
  a reason string that _names the field_. Logging only `event.code` throws away
  the single most useful diagnostic the service produces.

**Credential handling is the part not to improvise.** A browser cannot set
headers on a WebSocket, so the credential travels in the subprotocol, where any
script on the page can read it. `app/api/voice/token/route.ts` holds the real
key server-side and mints 30-second tokens. **It never falls back to the real
key when the grant fails** — that fallback is the tempting one-line fix during
development and it publishes the account.

**Status: written, not verified.** The build container's egress policy denies
`api.deepgram.com` and `agent.deepgram.com` at the gateway, so the protocol
constants come from documentation rather than observed behaviour. Everything the
service could disagree with is a named constant in `deepgram.ts`, and
`scripts/probe-deepgram.mjs` prints what it actually accepts — correcting it is
editing literals, not rewriting the client.

### Wake word — `src/brain/speech.ts` (236) + `useVoice.ts` (169) + `app/api/speech/route.ts` (91)

The older path: browser recognition listens for "SHIVA…", one utterance goes to
Gemini, one reply comes back. Kept because it needs no Deepgram key and costs
nothing while idle.

- `speakNeural()` decodes base64 PCM → `Int16Array` → `Float32Array` (÷32768)
  and plays via WebAudio. Sample rate is **parsed from the mime type**
  (`audio/L16;codec=pcm;rate=24000`), not assumed — a model that changes rate
  would otherwise play at the wrong pitch and sound like a different voice
  rather than like a bug.
- `speak()` falls back to `speechSynthesis` with macOS voice ordering:
  siri > premium/enhanced > natural/neural > named.
- `extractWakeCommand()` accepts `shiva | shivah | sheva | siva | shever`,
  because Web Speech transcribes the name inconsistently.
- Continuous recognition **ends itself on silence** and must be restarted from
  `onend` — with a backoff and a failure cap, or a revoked mic permission
  becomes an infinite restart loop that pins a core.

## 10. Live data

`src/adapters/data/types.ts` defines the contract, and the union is the point:

```ts
export type DataResult<T> =
  | { status: 'live'; data: T; fetchedAt: number }
  | { status: 'unconfigured'; missing: string[] }
  | { status: 'error'; message: string; at: number }
```

A source can be unconfigured, failed, or live, and the UI is _forced_ to
distinguish them. That's what stops a missing API key from rendering as an
empty-but-plausible panel — the most common way dashboards end up lying to the
people reading them. Worth stealing even if you take nothing else from this
section.

Implemented sources: **system** (measured in-browser: fps, memory, tracking),
**weather** (Open-Meteo, keyless, via `/api/data/weather`), **projects** (GitHub
public API via `/api/data/projects`). Calendar/Gmail are declared and marked
`liveIn: 3` — not connected.

Weather drives the 3D environment: the reported sky state selects the `ATMOSPHERE`
entry, so real rain outside means rain in the room.

---

## 11. Build, assets and the COEP requirement

### This one will bite you

```ts
// next.config.ts
{ key: 'Cross-Origin-Opener-Policy',   value: 'same-origin' },
{ key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
```

MediaPipe's vision WASM needs cross-origin isolation for `SharedArrayBuffer` and
threaded inference. **Without these headers it silently falls back to
single-threaded and roughly halves tracking throughput** — no error, just worse.

And COEP is exactly why the model and WASM are vendored same-origin rather than
loaded from jsdelivr: a cross-origin WASM fetch fails under COEP unless the CDN
opts in with CORP headers. Same-origin sidesteps it, and also survives corporate
proxies that block CDNs.

Check it survived your reverse proxy: `curl -I https://your-host/ | grep -i cross-origin`.

### Asset vendoring

`scripts/fetch-assets.mjs` runs on `postinstall`:

- copies `node_modules/@mediapipe/tasks-vision/wasm` → `public/mediapipe/`
- downloads `hand_landmarker.task` (float16, ~7.8 MB) → `public/models/`
- **guards against truncation**: anything under 5 MB is treated as a failed
  download (a proxy error page is a few KB and would otherwise be cached as valid)
- **never fails `npm install`** — the app detects the missing model at runtime and
  degrades to pointer control with a clear message

Both directories are gitignored. If your host blocks outbound network, run
`npm run assets` locally and upload `public/models`.

### Other requirements

- **HTTPS or `localhost` is mandatory.** `getUserMedia` refuses to run outside a
  secure context, so hand tracking simply won't start over plain HTTP or a bare
  LAN IP. `canUseCamera()` checks `window.isSecureContext` and reports it as a
  distinct status rather than a generic failure.
- `transpilePackages: ['three']`
- `BUILD_STANDALONE=1` gates `output: 'standalone'` (changes the start command to
  `node .next/standalone/server.js`, so it's opt-in — see `DEPLOY.md`)
- Immutable cache headers on `/models/*` and `/mediapipe/*`
- Node ≥ 20.9.0

### URL flags

| Flag                         | Effect                                                     |
| ---------------------------- | ---------------------------------------------------------- |
| `?quality=low\|medium\|high` | Pin the tier, disable the governor                         |
| `?debug=hands`               | Live tracking inspector — camera feed + skeleton + gates   |
| `?capture=1`                 | Enable `preserveDrawingBuffer` for screenshots/pixel tests |

---

## 12. Tests

Playwright, 45 passing + 1 GPU-dependent skip.

| File                        | Covers                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `tests/handPose.ts`         | **Synthetic anatomically-proportioned hand poses.** The foundation — lets gestures be tested with no camera. |
| `tests/calibrate.spec.ts`   | **Prints the measured ratio for each pose.** Run this to retune thresholds against data instead of guessing. |
| `tests/gestures.spec.ts`    | Recognition, hysteresis, circle detection, `reset()` emitting `gesture:end`                                  |
| `tests/sse.spec.ts`         | CRLF/LF/CR separators, final-frame flush, multi-line data                                                    |
| `tests/brain.spec.ts`       | Adapter behaviour, tool loop                                                                                 |
| `tests/render.spec.ts`      | Painted-pixel ratio vs clear colour — "is it actually black?"                                                |
| `tests/performance.spec.ts` | Throughput (skipped under SwiftShader) + stability (always asserted)                                         |
| `tests/quality.spec.ts`     | Tier degradation                                                                                             |

`tests/helpers.ts` has `samplePaint()` — the pixel-sampling helper that catches
"renders nothing" bugs a smoke test would pass straight through.

**`calibrate.spec.ts` is the one to keep** if you retune the recognizer for your
own gestures. Every threshold in §5 came out of its output.

---

## 13. Bugs already paid for — do not rediscover these

Ordered by how much time each cost.

1. **SSE frames separated by CRLF, not LF.** A reader splitting on `'\n\n'` finds
   no separator at all — the whole stream stays one unsplittable blob and only its
   first event is read. A 33-frame reply arrived as the string `"It'"`. Fixed by
   `const SEPARATOR = /\r\n\r\n|\n\n|\r\r/`. **Found only by comparing raw upstream
   frame counts against delivered events** — it produces no error.

2. **The final SSE frame has no trailing separator.** Treating the tail as
   always-partial silently discards it, and a short reply often arrives as one
   chunk that is _entirely_ final. `flush()` exists to make forgetting this
   impossible.

3. **Stuck grab.** `reset()` didn't emit `gesture:end`, so a tracking dropout
   mid-pinch left the panel grabbed forever with `inputMode` still `'hand'` — the
   pointer couldn't rescue it. §5.

4. **A grab gate that could never fire.** `Schmitt(0.55, 0.72)` on mean curl; a
   real fist measures 0.88. Unreachable. Fixed by switching to finger counts.

5. **`point` misclassified as `grab`** after that fix, because pointing folds three
   fingers too. Fixed by the `closedness = curled - extended*2` score.

6. **Invisible glass.** Transmission materials refract the environment map. With no
   envmap, the panels rendered as nothing at all. Fixed with a procedural float
   equirect + PMREM.

7. **Content planes buried inside the glass.** `ExtrudeGeometry` adds
   `bevelThickness` to _both_ ends, so the real half-depth was ±0.09, not the
   nominal ±0.07. Fixed by deriving offsets from `geometry.boundingBox`.

8. **Focus made panels smaller.** The focus animation moved the panel toward the
   ring centre — which is _away_ from the camera. Changed to `RADIUS * 1.08`.

9. **Keyboard shortcuts broke typing.** The global handlers call `preventDefault`,
   so Enter/Space/arrows didn't merely fire alongside typing, they made it
   impossible to send a message. Fixed with an `isTextEntry()` guard.

10. **A relaxed hand read as an open palm** (0.80 against a 0.78 gate), arming
    accidental swipes. The `EXTENDED`/`CURLED` dead zone exists for this.

11. **Retired model IDs.** `gemini-2.5-flash` 404s for newly-issued keys. Pin to
    aliases (`gemini-flash-latest`) and carry fallbacks.

12. **Tool-call-only turns reported as empty.** Track `sawToolCall` alongside
    `sawText`.

13. **`<line>` in JSX resolves to the SVG element, not `THREE.Line`.** Build it
    imperatively and mount via `<primitive>`.

14. **Texture `.clone()` in a render body** leaks a texture per frame. Move to
    `useMemo`, dispose in an effect.

15. **A leaked WebGL probe context** can starve the real canvas — browsers cap
    concurrent contexts. Always `WEBGL_lose_context`.

16. **`ChromaticAberration`'s props type collapses to
    `Partial<Options | undefined>`** upstream, erasing every prop. Only `offset`
    is usable.

17. **Conflated timers.** One ref pacing both inference and store reporting makes
    each reset the other's window.

---

## 14. Three merge strategies, with trade-offs

### A. Lift the gesture engine into your AI _(smallest, most likely right)_

Copy Tier 1 + Tier 2 (~1,000 lines, dependencies: `@mediapipe/tasks-vision` only).
Wire `on('gesture:start', …)` to whatever your AI's UI already does. Skip
`projection.ts` if you're not rendering 3D.

- **Cost:** you get gestures, not the look.
- **Risk:** low. This block is nearly standalone.
- **Must not skip:** the COEP headers (§11), asset vendoring (§11), and
  `reset()` emitting `gesture:end` (§5).

### B. Put your AI behind SHIVA's UI

Implement the `Brain` interface (§8) as an adapter around your existing AI, drop
it into `app/api/brain/route.ts`, and delete `src/adapters/brain/gemini.ts`.
Everything else — spatial UI, gestures, voice, panels — keeps working.

- **Cost:** you adopt Next.js 15 App Router + R3F.
- **Risk:** low if your AI can stream; moderate if it can't (the holographic text
  renderer assumes token deltas).
- **Biggest win:** you get the whole interface for one adapter file.

### C. Both codebases side by side, sharing the event bus

Run SHIVA as the presentation surface, your AI as the brain, and let them talk
over `bus.ts` (in-process) or a websocket carrying the same event shapes.

- **Cost:** two things to deploy, one contract to keep in sync.
- **Best when:** your AI has infrastructure (memory, tools, background jobs) that
  doesn't want to live inside a Next.js app.

**Recommendation:** if your AI's strength is the brain and you want SHIVA's face,
take **B** — it's one file. If you want gestures in an interface you already like,
take **A**. **C** only if your AI genuinely can't be called from a Next.js route.

---

## 15. Complete file inventory

```
app/
  layout.tsx                             27   root layout, fonts, metadata
  page.tsx                                4   renders <Shell/>
  globals.css                           154   Tailwind v4 @theme tokens, palette
  api/brain/route.ts                    103   edge; streams the brain (server-only key)
  api/speech/route.ts                    91   edge; Gemini TTS → base64 PCM
  api/voice/token/route.ts               96   edge; mints 30s Deepgram tokens —
                                              never falls back to the real key
  api/data/weather/route.ts             122   Open-Meteo proxy (keyless)
  api/data/projects/route.ts            149   GitHub public API proxy

src/
  Shell.tsx                              71   top-level composition; all non-render concerns

  lib/
    one-euro.ts                         115  ★ adaptive filter — TAKE THIS
    math.ts                              73  ★ damp, dampAngle, Schmitt — TAKE THIS
    sse.ts                               68  ★ CRLF-safe SSE framer
    pcm.ts                               76  ★ float32↔int16 + resample (tested)
    device.ts                           146   GPU probe, tier selection, URL flags

  core/
    types.ts                             77  ★ HandState, Vec3, GestureName
    events/bus.ts                        69  ★★ THE INTEGRATION SEAM
    hands/handFrame.ts                   81  ★★ the 60Hz mutable singleton
    config/quality.ts                    71   per-tier render budget
    config/palette.ts                    44   literal colours for Canvas2D/three
    config/modules.ts                    68   carousel contents + liveIn honesty
    store/useSystemStore.ts              67
    store/useGestureStore.ts             50
    store/useSpatialStore.ts             48
    store/useBrainStore.ts               91
    store/useDataStore.ts               110

  spatial/
    hands/gestureRecognizer.ts          398  ★★★ THE CORE ASSET
    hands/useHandTracking.ts            278  ★★ camera + MediaPipe + rAF loop
    hands/useInteractionDriver.ts       332  ★★ gesture policy + pointer fallback
    hands/projection.ts                  43  ★ tracking space → world space
    hands/videoSource.ts                 20  ★ module slot for the video element
    hands/HandCursors.tsx               179   3D cursors with trails
    Stage.tsx                            90   Canvas, tone mapping, colour space
    CameraRig.tsx                        82   parallax + focus framing
    PerformanceGovernor.tsx             107   runtime tier stepping
    carousel/Carousel.tsx               193   ring layout, rotation, grab/throw
    carousel/GlassPanel.tsx             320   transmission glass + measured bbox
    carousel/panelTexture.ts            242   Canvas2D face rendering
    carousel/panelContent.ts            178   readPanel() → 4-state PanelReadout
    environment/Environment.tsx         142   ATMOSPHERE per sky, damped transitions
    environment/StudioEnvironment.tsx   140   float equirect + PMREM (makes glass visible)
    environment/VolumetricFog.tsx       155
    environment/Precipitation.tsx       163   GPU fract() wrapping
    environment/Particulate.tsx         134   GPU-only motion
    environment/InfiniteGrid.tsx        100
    environment/LightSource.tsx          36   god-ray occluder
    effects/EffectStack.tsx             134   bloom, DoF, god rays, CA
    brain/HolographicText.tsx           288   streamed-token 3D text

  brain/
    useBrain.ts                         212   turn loop, streaming, tool round-trip
    executeTool.ts                       78  ★ the one tool dispatcher, shared by
                                             both brains so they cannot diverge
    useVoiceAgent.ts                    445  ★★ live voice socket, barge-in, worklet
    useVoice.ts                         169   Web Speech recognition + wake word
    speech.ts                           236   neural + browser TTS, say()

  adapters/
    brain/types.ts                       90  ★ the Brain contract — implement this
    brain/gemini.ts                     339   Gemini SSE adapter w/ fallbacks
    brain/commands.ts                   143  ★ tool schemas + anti-fabrication prompt
    voice/deepgram.ts                   214  ★ Voice Agent protocol; every value the
                                             service could reject is a constant here
    data/types.ts                        57  ★ DataResult union — steal this idea
    data/sources.ts                      71

  data/useLiveData.ts                   196   polling, backoff, visibility handling

  audio/
    engine.ts                           211   WebAudio: transients, drones, confirms
    useAudioEngine.ts                    58   binds engine to bus events

  hud/
    Hud.tsx                             208   status chrome, tracking toggle
    BootSequence.tsx                    122
    BrainConsole.tsx                    164   text input + transcript
    HandDebugOverlay.tsx                143  ★ ?debug=hands — keep this

tests/
  handPose.ts                           149  ★ synthetic hand poses
  calibrate.spec.ts                      41  ★ prints measured ratios — RETUNE WITH THIS
  gestures.spec.ts                      195
  sse.spec.ts                           117
  pcm.spec.ts                           101   PCM conversion + resampling
  voice.spec.ts                          89   handshake invariants, close messages
  brain.spec.ts                         172
  render.spec.ts                        139
  performance.spec.ts                    98
  quality.spec.ts                        58
  helpers.ts                            132   samplePaint(), boot helpers

scripts/
  fetch-assets.mjs                       89  ★ vendors WASM + model
  probe-deepgram.mjs                    241   API discovery — run this first
```

★ = worth taking · ★★ = take · ★★★ = the reason this document exists

---

## Appendix — minimum viable extraction

The smallest thing that gives another app working hand gestures:

```
package.json:  "@mediapipe/tasks-vision": "1.0.1"

src/lib/one-euro.ts
src/lib/math.ts
src/core/types.ts
src/core/events/bus.ts              ← trim EventMap to your events
src/core/hands/handFrame.ts
src/spatial/hands/videoSource.ts
src/spatial/hands/gestureRecognizer.ts
src/spatial/hands/useHandTracking.ts ← replace useGestureStore/useSystemStore refs
scripts/fetch-assets.mjs            ← wire to postinstall
next.config.ts headers              ← COOP/COEP, or tracking runs at half speed
```

Then:

```ts
import { on } from './core/events/bus'
import { getPrimaryHand } from './core/hands/handFrame'
import { useHandTracking } from './spatial/hands/useHandTracking'

const { start } = useHandTracking() // call from a user gesture — camera permission

on('gesture:start', ({ gesture, hand }) => {
  /* pinch | grab | palm | point */
})
on('gesture:swipe', ({ direction }) => {
  /* -1 | 1 */
})
on('brain:wake', () => {
  /* circle traced — start listening */
})

// continuous position, read inside your render loop only:
const hand = getPrimaryHand() // → { position, tip, pinch, grab, openness, velocity } | null
```

Two things that will break it if you skip them: the **COOP/COEP headers**, and
**`reset()` emitting `gesture:end`**.
