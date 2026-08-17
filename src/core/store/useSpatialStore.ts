'use client'

import { create } from 'zustand'
import { MODULE_COUNT } from '@/core/config/modules'

/**
 * Carousel and panel state.
 *
 * `index` is intentionally unbounded — it accumulates in both directions and
 * the renderer wraps it. Clamping to 0..n-1 would make stepping past the end
 * jump backwards through every panel instead of continuing around the ring.
 */
interface SpatialState {
  index: number
  /** Panel index currently expanded to focus, or null. */
  focused: number | null
  /** Panel index currently held by a hand, or null. */
  grabbed: number | null
  /** Ambient camera drift, disabled while the user is actively driving. */
  idle: boolean
  audioEnabled: boolean

  step: (direction: -1 | 1) => void
  setIndex: (index: number) => void
  focus: (index: number | null) => void
  setGrabbed: (index: number | null) => void
  setIdle: (idle: boolean) => void
  setAudioEnabled: (enabled: boolean) => void
}

export const useSpatialStore = create<SpatialState>((set) => ({
  index: 0,
  focused: null,
  grabbed: null,
  idle: true,
  audioEnabled: false,

  step: (direction) => set((s) => ({ index: s.index + direction, idle: false })),
  setIndex: (index) => set({ index, idle: false }),
  focus: (focused) => set({ focused, idle: false }),
  setGrabbed: (grabbed) => set({ grabbed }),
  setIdle: (idle) => set({ idle }),
  setAudioEnabled: (audioEnabled) => set({ audioEnabled }),
}))

/** Normalised 0..MODULE_COUNT-1 index for whichever panel faces the camera. */
export const activeModuleIndex = (index: number): number =>
  ((Math.round(index) % MODULE_COUNT) + MODULE_COUNT) % MODULE_COUNT
