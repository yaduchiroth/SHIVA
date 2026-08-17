'use client'

import { create } from 'zustand'
import { MODULE_COUNT } from '@/core/config/modules'
import { clamp } from '@/lib/math'

/**
 * How far the two-handed zoom may travel.
 *
 * Bounded because both ends have a floor beyond which the interface stops
 * working rather than just looking different: too close and the front panel is
 * cropped by the frame with its neighbours out of view entirely, too far and
 * the readouts are below the size at which they can be read at all.
 */
const DOLLY_MIN = 0.6
const DOLLY_MAX = 1.7

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
  /**
   * Multiplier on camera distance, driven by the two-handed spread gesture.
   *
   * A multiplier rather than an absolute position so the camera's own
   * choreography — the pull-in on focus, the idle drift — keeps working
   * underneath it. Storing a position would mean the dolly fighting the rig
   * for control of the same number.
   */
  dolly: number
  audioEnabled: boolean

  step: (direction: -1 | 1) => void
  setIndex: (index: number) => void
  focus: (index: number | null) => void
  setGrabbed: (index: number | null) => void
  setIdle: (idle: boolean) => void
  /** Applies a relative zoom factor. Clamped; see DOLLY_MIN/DOLLY_MAX. */
  adjustDolly: (factor: number) => void
  resetDolly: () => void
  setAudioEnabled: (enabled: boolean) => void
}

export const useSpatialStore = create<SpatialState>((set) => ({
  index: 0,
  focused: null,
  grabbed: null,
  idle: true,
  dolly: 1,
  audioEnabled: false,

  step: (direction) => set((s) => ({ index: s.index + direction, idle: false })),
  setIndex: (index) => set({ index, idle: false }),
  focus: (focused) => set({ focused, idle: false }),
  setGrabbed: (grabbed) => set({ grabbed }),
  setIdle: (idle) => set({ idle }),

  adjustDolly: (factor) =>
    set((s) => {
      const next = clamp(s.dolly * factor, DOLLY_MIN, DOLLY_MAX)
      // Zoom arrives every frame while the gesture is held, and most frames
      // change nothing once clamped. Returning the same object stops those from
      // waking every subscriber sixty times a second for no visible difference.
      return next === s.dolly ? s : { dolly: next, idle: false }
    }),

  resetDolly: () => set({ dolly: 1 }),
  setAudioEnabled: (audioEnabled) => set({ audioEnabled }),
}))

/** Normalised 0..MODULE_COUNT-1 index for whichever panel faces the camera. */
export const activeModuleIndex = (index: number): number =>
  ((Math.round(index) % MODULE_COUNT) + MODULE_COUNT) % MODULE_COUNT
