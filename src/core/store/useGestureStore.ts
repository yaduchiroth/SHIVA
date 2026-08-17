'use client'

import { create } from 'zustand'
import type { GestureName, InputMode, TrackingStatus } from '@/core/types'

/**
 * The low-frequency half of hand state — see `core/hands/handFrame.ts` for the
 * continuous half and why they're separated.
 *
 * Everything here changes at human speed (a few times a second at most), so
 * re-rendering on it is not just acceptable, it's the intent.
 */
interface GestureState {
  status: TrackingStatus
  inputMode: InputMode
  /** Hands currently visible, 0–2. */
  handsVisible: number
  /** Latest discrete gesture per hand, for HUD readout. */
  leftGesture: GestureName
  rightGesture: GestureName
  /** Non-fatal explanation shown when tracking can't start. */
  reason: string | null
  /** Rolling inference cost, ms — updated at ~2 Hz. */
  inferenceMs: number

  setStatus: (status: TrackingStatus, reason?: string | null) => void
  setInputMode: (mode: InputMode) => void
  setHandsVisible: (count: number) => void
  setGesture: (hand: 'left' | 'right', gesture: GestureName) => void
  setInferenceMs: (ms: number) => void
}

export const useGestureStore = create<GestureState>((set) => ({
  status: 'idle',
  // Pointer is the honest default: hand tracking is opt-in behind a permission
  // prompt, so the OS must be fully usable before that prompt is ever answered.
  inputMode: 'pointer',
  handsVisible: 0,
  leftGesture: 'idle',
  rightGesture: 'idle',
  reason: null,
  inferenceMs: 0,

  setStatus: (status, reason = null) => set({ status, reason }),
  setInputMode: (inputMode) => set({ inputMode }),
  setHandsVisible: (handsVisible) => set({ handsVisible }),
  setGesture: (hand, gesture) =>
    set(hand === 'left' ? { leftGesture: gesture } : { rightGesture: gesture }),
  setInferenceMs: (inferenceMs) => set({ inferenceMs }),
}))
