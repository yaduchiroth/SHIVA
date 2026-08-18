'use client'

import { create } from 'zustand'
import type { LinkStatus } from '@/adapters/odin/client'
import type { CompanionSpec, CompanionState, DeviceSpec, OdinState } from '@/adapters/odin/protocol'

/**
 * What Odin is currently doing, as far as SHIVA can see.
 *
 * Discrete, low-frequency state — the roster changes when a companion file is
 * edited, presence when someone walks in front of the camera — so it belongs in
 * a store where re-rendering is the point. Anything arriving at frame rate goes
 * to a mutable singleton instead; see `orbDrive` and `handFrame`.
 */

export interface CompanionRuntime extends CompanionSpec {
  state: CompanionState
  /** What it was last asked to do, for the label on its orb. */
  task: string
  /** The dispatch id currently in flight, if any. */
  dispatchId: string | null
}

/** Bounded: this is a scrolling log, not a record. */
const MAX_LOG = 60

interface OdinStoreState {
  link: LinkStatus
  /** Odin's conversational state, which drives the orb's colour when linked. */
  state: OdinState
  /** Whether Odin is awake or has been told to stand down. */
  awake: boolean
  /** Who Heimdall last recognised, and whether it knew them. */
  presence: { name: string; known: boolean } | null
  companions: CompanionRuntime[]
  devices: DeviceSpec[]
  log: { text: string; at: number }[]

  setLink: (link: LinkStatus) => void
  setState: (state: OdinState) => void
  setAwake: (awake: boolean) => void
  setPresence: (name: string, known: boolean) => void
  setRoster: (items: CompanionSpec[]) => void
  setDevices: (items: DeviceSpec[]) => void
  dispatch: (id: string, slug: string, task: string) => void
  setCompanionState: (slug: string, state: CompanionState) => void
  returnDispatch: (id: string, slug: string, ok: boolean) => void
  clearDispatch: () => void
  appendLog: (text: string) => void
  reset: () => void
}

const idle = {
  link: { status: 'off' } as LinkStatus,
  state: 'idle' as OdinState,
  awake: true,
  presence: null,
  companions: [] as CompanionRuntime[],
  devices: [] as DeviceSpec[],
  log: [] as { text: string; at: number }[],
}

export const useOdinStore = create<OdinStoreState>((set) => ({
  ...idle,

  setLink: (link) => set({ link }),
  setState: (state) => set({ state }),
  setAwake: (awake) => set({ awake }),
  setPresence: (name, known) => set({ presence: { name, known } }),

  setRoster: (items) =>
    set((s) => {
      // Runtime state survives a roster refresh. Odin re-emits the roster
      // whenever a companion file changes, and resetting every orb to dormant
      // mid-errand would make working companions look idle while they are
      // still out.
      const previous = new Map(s.companions.map((c) => [c.slug, c]))
      return {
        companions: items.map((spec) => ({
          ...spec,
          state: previous.get(spec.slug)?.state ?? 'dormant',
          task: previous.get(spec.slug)?.task ?? '',
          dispatchId: previous.get(spec.slug)?.dispatchId ?? null,
        })),
      }
    }),

  setDevices: (devices) => set({ devices }),

  dispatch: (id, slug, task) =>
    set((s) => ({
      companions: s.companions.map((c) =>
        c.slug === slug ? { ...c, state: 'working', task, dispatchId: id } : c,
      ),
    })),

  setCompanionState: (slug, state) =>
    set((s) => ({
      companions: s.companions.map((c) => (c.slug === slug ? { ...c, state } : c)),
    })),

  returnDispatch: (id, slug, ok) =>
    set((s) => ({
      companions: s.companions.map((c) =>
        // Matched on the dispatch id as well as the slug: the same companion
        // can be sent out twice, and a late return from the first errand must
        // not stand the second one down.
        c.slug === slug && (c.dispatchId === id || c.dispatchId === null)
          ? { ...c, state: ok ? 'done' : 'failed', dispatchId: null }
          : c,
      ),
    })),

  clearDispatch: () =>
    set((s) => ({
      companions: s.companions.map((c) => ({ ...c, state: 'dormant', task: '', dispatchId: null })),
    })),

  appendLog: (text) => set((s) => ({ log: [...s.log, { text, at: Date.now() }].slice(-MAX_LOG) })),

  reset: () => set({ ...idle }),
}))
