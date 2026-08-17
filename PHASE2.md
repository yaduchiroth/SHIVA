# Phase 2 handoff — AI brain, voice, command engine

Phase 1 is the spatial OS shell. This is what Phase 2 needs to know about it,
written while the decisions were still fresh.

## What already exists that Phase 2 should use

**The event bus** (`src/core/events/bus.ts`) is the integration point. The brain
publishes onto it exactly like the gesture recognizer does, so a voice command
that rotates the carousel goes through the same path a swipe does. Add intents
to `EventMap` rather than inventing a second channel.

**State is split by update frequency** (`src/core/hands/handFrame.ts` explains
why). Streaming tokens are high-frequency: assemble them into a mutable buffer
read by the render loop, not into Zustand. Putting a token stream in the store
will re-render the tree once per token and visibly cost frames.

**The brain contract is already defined** in `src/adapters/brain/types.ts`, and
`gemini.ts` carries implementation notes on the API's sharp edges — the `alt=sse`
requirement, the `user`/`model` role vocabulary, `systemInstruction` being
separate from messages, and `blockReason` handling. Read that file before
writing the client; each note is there because it's a non-obvious failure.

**Quality tiers** (`src/core/config/quality.ts`) already gate expensive
features. Particle-assembled holographic text should get a tier entry rather
than a hard-coded particle count.

## The work

### 1. Server route

`app/api/brain/route.ts`, streaming SSE. `GEMINI_API_KEY` must stay server-side —
it is deliberately not `NEXT_PUBLIC_`. Phase 1 sets COEP headers globally
(`next.config.ts`), which is worth remembering if you add any cross-origin fetch.

### 2. Voice

Web Speech API for STT and TTS gets you working voice with zero dependencies.
Two things to plan for:

- `SpeechRecognition` is Chromium-only under that name and needs the
  `webkitSpeechRecognition` alias. Firefox has no support — the text input path
  must therefore be a first-class fallback, not an afterthought.
- Continuous recognition stops on its own after silence. It needs restarting
  from `onend`, with a guard against restart storms when the mic is unavailable.

For genuinely realtime conversation, the Gemini Live API's bidirectional audio
is a better fit than STT→text→TTS, at the cost of a WebSocket session to manage.

### 3. Wake phrase and circle gesture

"SHIVA" as a wake word via continuous recognition. The circle gesture wants a
new recognizer in `src/spatial/hands/gestureRecognizer.ts`: buffer index-tip
positions over ~1.5s and test for angular coverage exceeding 2π with a roughly
constant radius. Follow the existing pattern — filter first, then threshold with
hysteresis, or it will trigger constantly during ordinary movement.

### 4. Holographic response text

Particles assembling into glyphs. `src/spatial/environment/Particulate.tsx` has
the GPU-side pattern to follow: motion as a closed-form function of time in the
vertex shader, never per-frame JS buffer writes. Sample glyph coverage from a
Canvas2D render (same approach as `panelTexture.ts`) to get target positions.

### 5. Command engine

Tool definitions per module. The `ModuleDescriptor.liveIn` field already records
which modules have real data — the brain should refuse to answer questions about
modules whose sources land in Phase 3 rather than inventing plausible numbers.
That honesty is a deliberate property of the Phase 1 design (see
`src/adapters/data/types.ts`) and is worth preserving.

## Constraints worth keeping

- **Nothing fabricates data.** Panels show real values or say they can't.
- **Pointer parity.** Every capability reachable by voice or gesture stays
  reachable without a camera or microphone.
- **The frame budget is the product.** Inference and streaming both belong off
  the render loop; `useHandTracking.ts` shows the pattern.
