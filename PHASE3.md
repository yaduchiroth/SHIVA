# Phase 3 handoff — real data behind the panels

Phase 2 built the brain, voice and command engine. Phase 3 connects the four
modules that currently declare themselves unconnected: Schedule, Projects,
Markets, Reach.

## The constraint that shapes everything here

`src/adapters/data/types.ts` defines `DataResult<T>` as a union of `live`,
`unconfigured` and `error`. That union is not defensive boilerplate — it is what
forces every caller to distinguish "I have this data" from "I cannot get it",
and it is the mechanism that keeps SHIVA from inventing numbers.

The same guarantee runs through the brain: `buildSystemPrompt` in
`src/adapters/brain/commands.ts` derives the live/unconnected module lists from
`ModuleDescriptor.liveIn`, so flipping a module to `liveIn: 1` automatically
stops the model declining to discuss it. Nothing else needs editing, and there
is no second list to forget to update. `tests/brain.spec.ts` asserts the
instruction survives prompt edits.

## The work

### 1. Google OAuth (Calendar + Gmail)

One consent flow covers both — two separate flows for the same Google account is
a worse experience for no benefit. Scopes: `calendar.readonly` and
`gmail.metadata`. The metadata scope returns headers without message bodies,
which is enough for unread counts and sender summaries and avoids asking for
access to the contents of every email you have ever received.

Needs a token store. Refresh tokens outlive the process, so this is the first
piece of state SHIVA cannot keep in memory.

### 2. GitHub

A fine-grained PAT with read-only `contents`, `pull_requests` and `checks`.
Prefer the GraphQL API: the `RepoSummary` shape needs PRs, review requests and CI
status, which is three REST round-trips per repo and one GraphQL query.

### 3. Markets and Reach

Markets needs a quote source; most free tiers are heavily rate-limited, so cache
server-side and treat a rate-limit response as `error`, not as stale-but-fine.
Instagram requires a Meta app with `instagram_graph_user_profile` — the heaviest
setup of anything here, and worth doing last.

### 4. Panel visualisation

Panel faces are Canvas2D textures (`src/spatial/carousel/panelTexture.ts`). The
instrument bar field there is currently ornament drawn from a deterministic
hash; Phase 3 replaces its input with real series data. Keep it deterministic
per-value — a readout that reshuffles on every re-render reads as noise.

For the 3D charts the design doc calls for, follow the pattern in
`src/spatial/environment/Particulate.tsx` and
`src/spatial/brain/HolographicText.tsx`: geometry authored once, motion as a
closed-form function of time in the vertex shader, never per-frame buffer
writes from JS.

### 5. New tools

Each data source should get a brain tool alongside its panel, so "what's on my
calendar tomorrow" answers rather than merely navigating. Add them to `TOOLS`
in `commands.ts` and to the dispatcher in `src/brain/useBrain.ts`. Tools that
read data will need to return results into the conversation — the
`tool-result` event already exists in `BrainEvent` for this, and is currently
unused.

## Constraints worth keeping

- **Nothing fabricates data.** The whole architecture is arranged around this.
- **Pointer parity.** Everything reachable by voice or gesture stays reachable
  without a camera or microphone.
- **The frame budget is the product.** Data fetching belongs on the server or
  behind a throttle, never in the render loop.
- **Thresholds and tunings are measured.** Two gestures shipped broken in Phase 1
  because their thresholds were estimates. If a new interaction needs a
  threshold, calibrate it the way `tests/calibrate.spec.ts` does.
