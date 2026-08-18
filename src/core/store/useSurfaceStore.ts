'use client'

import { create } from 'zustand'
import type { StreamSource } from '@/adapters/mind/streams'

/**
 * The screens floating around the room.
 *
 * Separate from `useSpatialStore`, which owns the six fixed instrument panels
 * on the carousel. Those are structural — always present, always the same six.
 * These are whatever SHIVA has decided to show you: a report it just wrote, a
 * chart, a page it opened, a stream from a camera. They come and go, so they
 * are a list rather than a ring.
 *
 * Content is a discriminated union rather than a `kind` plus a loose payload,
 * so adding a screen type is a compile error everywhere that renders one until
 * it is handled. The alternative — an untyped bag — fails at runtime, on the
 * one machine that happened to receive the new kind.
 */

export interface ChartSeries {
  name: string
  values: number[]
}

export interface ConnectorItem {
  name: string
  status?: string
  detail?: string
  /** Undefined means the mind did not say, which is not the same as offline. */
  online?: boolean
}

export type SurfaceContent =
  /** A headline and some prose. The cheapest thing SHIVA can put in the room. */
  | { kind: 'card'; title: string; body: string }
  /** Arbitrary HTML, authored by a model. Rendered sandboxed — see Report. */
  | { kind: 'report'; title: string; html: string }
  | {
      kind: 'chart'
      title: string
      ctype: 'bar' | 'line'
      labels: string[]
      series: ChartSeries[]
      unit: string
    }
  /** A live page by URL. Many sites refuse to be embedded; the surface says so. */
  | { kind: 'web'; title: string; url: string }
  /**
   * A live JPEG feed — Nandi's camera, or a shared Mac screen.
   *
   * Carries no pixels. Frames arrive several times a second and live in
   * `adapters/mind/streams`, outside React, because putting them here would
   * re-render the entire wall on every frame to update one image.
   */
  | { kind: 'stream'; title: string; source: StreamSource }
  /** What the mind is connected to, and what it is still missing. */
  | { kind: 'connectors'; title: string; items: ConnectorItem[] }

export type SurfaceKind = SurfaceContent['kind']

export interface Surface {
  id: string
  content: SurfaceContent
  /** When it arrived. Drives eviction and the "newest first" ordering. */
  at: number
  /**
   * Set while the surface is easing out, before it is actually dropped.
   *
   * Removal used to be instantaneous, which meant a closed surface vanished
   * mid-frame and its neighbours snapped into the gap — the single most jarring
   * transition in the interface. Marking it instead lets it shrink and fade
   * where it stands, and the neighbours reflow once it is gone rather than
   * racing it.
   */
  removing?: boolean
  /** Size multiplier from the two-handed pinch. 1 when never scaled. */
  scale?: number
}

/**
 * How long a surface takes to ease out before it is dropped from the list.
 *
 * Matches the `EASE` damping rate the component animates with, so the surface
 * is essentially invisible by the time it disappears. Shorter and it pops out
 * mid-fade; longer and the gap it leaves sits empty.
 */
export const EXIT_MS = 350

/**
 * Two rows of three.
 *
 * Not a taste judgement — it is what fits. `wallFitsFrustum` in the layout
 * proves that six surfaces at the wall distance stay inside a 4:3 window with
 * their full width and height showing; a seventh starts a third row that runs
 * off the top. A screen you cannot see is worse than no screen, because it
 * still occupies the room and the eviction queue.
 */
export const MAX_SURFACES = 6

interface SurfaceState {
  surfaces: Surface[]
  /** The surface pulled forward for reading, or null. */
  focused: string | null
  /** The surface currently held by a hand or the pointer, or null. */
  grabbed: string | null

  /**
   * Adds a surface, or replaces one with the same id.
   *
   * Replacing by id is what lets a repeatedly-updated screen — a chart being
   * refreshed, a stream — stay in its slot instead of marching across the wall
   * and evicting its neighbours.
   */
  push: (content: SurfaceContent, id?: string) => string
  remove: (id: string) => void
  clear: () => void
  focus: (id: string | null) => void
  setGrabbed: (id: string | null) => void
  /**
   * Multiplies a surface's size. Clamped, because both ends stop being useful:
   * below half the type is unreadable, above two and a half a single surface
   * hides the ones beside it.
   */
  scale: (id: string, factor: number) => void
  /** Takes a surface out of this window's wall, whole, to hand to the other one. */
  detach: (id: string) => Surface | null
  /** Puts a surface arriving from the other window onto this wall. */
  attach: (surface: Surface) => void
}

let counter = 0
const nextId = (): string => `surface-${++counter}`

export const MIN_SCALE = 0.5
export const MAX_SCALE = 2.5

export const useSurfaceStore = create<SurfaceState>((set, get) => ({
  surfaces: [],
  focused: null,
  grabbed: null,

  push: (content, id) => {
    const key = id ?? nextId()
    set((s) => {
      const existing = s.surfaces.findIndex((v) => v.id === key)
      if (existing >= 0) {
        const next = s.surfaces.slice()
        // `at` is preserved deliberately: an update is not a new arrival, and
        // refreshing it would keep pushing the surface to the front of the
        // eviction queue and starve everything else.
        //
        // `removing` is cleared, so pushing to an id that is mid-fade brings it
        // back rather than adding a duplicate that the pending timer would then
        // delete along with the original.
        next[existing] = { ...next[existing]!, content, removing: false }
        return { surfaces: next }
      }
      return {
        surfaces: [...s.surfaces, { id: key, content, at: Date.now() }].slice(-MAX_SURFACES),
      }
    })
    return key
  },

  remove: (id) => {
    const existing = get().surfaces.find((v) => v.id === id)
    // Already leaving: a second close must not schedule a second drop, or the
    // timer fires after the id has been reused and takes the new surface with it.
    if (!existing || existing.removing) return
    set((s) => ({
      surfaces: s.surfaces.map((v) => (v.id === id ? { ...v, removing: true } : v)),
      // Focus releases immediately. A surface on its way out should not still
      // be pulled forward while it fades.
      focused: s.focused === id ? null : s.focused,
    }))
    setTimeout(() => {
      // Guarded on `removing`, not just the id: a push to the same id during
      // the fade revives the surface, and an unguarded filter would delete the
      // revived one when the old timer came due.
      set((s) => ({ surfaces: s.surfaces.filter((v) => !(v.id === id && v.removing)) }))
    }, EXIT_MS)
  },

  clear: () => {
    const ids = get().surfaces.map((v) => v.id)
    for (const id of ids) get().remove(id)
  },

  focus: (focused) => set({ focused }),
  setGrabbed: (grabbed) => set({ grabbed }),

  scale: (id, factor) =>
    set((s) => ({
      surfaces: s.surfaces.map((v) =>
        v.id === id
          ? { ...v, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, (v.scale ?? 1) * factor)) }
          : v,
      ),
    })),

  detach: (id) => {
    const surface = get().surfaces.find((v) => v.id === id)
    if (!surface) return null
    // Removed outright rather than marked `removing`: it is not going away, it
    // is going somewhere else, and a fade here would race the arrival there.
    set((s) => ({
      surfaces: s.surfaces.filter((v) => v.id !== id),
      focused: s.focused === id ? null : s.focused,
      grabbed: s.grabbed === id ? null : s.grabbed,
    }))
    return { ...surface, removing: false }
  },

  attach: (surface) =>
    set((s) => ({
      // Filtered first, so a surface sent across and back does not arrive
      // alongside a stale copy of itself.
      surfaces: [...s.surfaces.filter((v) => v.id !== surface.id), surface].slice(-MAX_SURFACES),
    })),
}))

/** Resets the id counter too, so tests do not depend on execution order. */
export function resetSurfaces(): void {
  counter = 0
  useSurfaceStore.setState({ surfaces: [], focused: null, grabbed: null })
}

/**
 * Puts one of each kind of surface in the room (`?surfaces=demo`).
 *
 * Exists for two reasons that happen to be the same reason. It lets the test
 * suite exercise every renderer without a live model behind `/api/brain`, and
 * it lets a human see what the wall does on a machine with a real GPU without
 * having to think of a prompt first. Judging whether this looks right is
 * something only a person on real hardware can do, so it should take one URL
 * parameter, not a conversation.
 *
 * Follows the same opt-in convention as `?capture=1` and `?debug=hands`: off
 * unless asked for, so it costs nothing in normal use.
 */
export function seedDemoSurfaces(): void {
  const { push } = useSurfaceStore.getState()

  push(
    {
      kind: 'card',
      title: 'Standing brief',
      body: 'Three things want you today.\n\nThe Hostinger deploy is still running the old build — the governor fix is in main but has not been rebuilt.\n\nTwo API keys from this week are in a transcript and should be rotated.\n\nOdin is public. Its companion briefs are readable by anyone.',
    },
    'demo-card',
  )

  push(
    {
      kind: 'chart',
      title: 'Frame budget by tier',
      ctype: 'bar',
      labels: ['low', 'medium', 'high'],
      series: [
        { name: 'neurons', values: [90, 240, 600] },
        { name: 'protons', values: [60, 160, 400] },
        { name: 'glyphs', values: [0, 300, 1200] },
      ],
      unit: 'instances',
    },
    'demo-chart',
  )

  push(
    {
      kind: 'report',
      title: 'Draw calls, before and after',
      html: `
        <h2>One object, two implementations</h2>
        <p>The orb as inherited, against the orb as rebuilt for this scene.</p>
        <table>
          <thead><tr><th>Layer</th><th>Was</th><th>Is</th></tr></thead>
          <tbody>
            <tr><td>Shell wireframe</td><td>~250 lines</td><td>1</td></tr>
            <tr><td>Drifting glyphs</td><td>1,700 sprites</td><td>1</td></tr>
            <tr><td>Orbiting protons</td><td>250 meshes</td><td>1</td></tr>
            <tr><td>Neural network</td><td>—</td><td>2</td></tr>
            <tr><td>Core and rings</td><td>5</td><td>5</td></tr>
          </tbody>
        </table>
        <p>Texture memory fell from roughly 55&nbsp;MB to 1.5&nbsp;MB, and the
        per-frame JavaScript from 1,700 sprite repositions to none.</p>
      `,
    },
    'demo-report',
  )

  push({ kind: 'web', url: 'https://example.com', title: 'example.com' }, 'demo-web')
}
