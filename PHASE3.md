# Phase 4 handoff — the remaining data sources

Phase 3 connected System (measured), Environment (Open-Meteo, driving the 3D
weather) and Projects (GitHub GraphQL). Three modules remain unconnected and say
so: Schedule, Markets, Reach.

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

### 2. Markets and Reach

Markets needs a quote source; most free tiers are heavily rate-limited, so cache
server-side and treat a rate-limit response as `error`, not as stale-but-fine.
Instagram requires a Meta app with `instagram_graph_user_profile` — the heaviest
setup of anything here, and worth doing last.

### 3. Adding a source

The plumbing is done; a new source is now four edits:

1. A route under `app/api/data/`, returning the `{status, data|missing|reason}`
   envelope every other source returns.
2. A snapshot type and slot in `src/core/store/useDataStore.ts`.
3. A case in `readPanel` (`src/spatial/carousel/panelContent.ts`) mapping it to
   a headline, series and rows. Panels repaint automatically when the readout
   changes.
4. Flip the module's `liveIn` to 1 in `src/core/config/modules.ts`. The system
   prompt derives its live/unconnected lists from that field, so the brain stops
   declining to discuss it with no prompt edit.

`read_module` already exposes any live source to the brain — extend its enum.

### 4. 3D charts

The design doc calls for charts as geometry rather than texture. Follow
`src/spatial/environment/Precipitation.tsx`: attributes authored once, motion as
a closed-form function of time in the vertex shader, never per-frame buffer
writes from JS.

## Constraints worth keeping

- **Nothing fabricates data.** The whole architecture is arranged around this.
- **Pointer parity.** Everything reachable by voice or gesture stays reachable
  without a camera or microphone.
- **The frame budget is the product.** Data fetching belongs on the server or
  behind a throttle, never in the render loop.
- **Thresholds and tunings are measured.** Two gestures shipped broken in Phase 1
  because their thresholds were estimates. If a new interaction needs a
  threshold, calibrate it the way `tests/calibrate.spec.ts` does.
