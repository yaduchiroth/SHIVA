'use client'

import { handFrame } from '@/core/hands/handFrame'
import { useGestureStore } from '@/core/store/useGestureStore'
import { useSurfaceStore, type SurfaceContent } from '@/core/store/useSurfaceStore'
import { driveDomPointer, pointerBridgeState } from '@/spatial/hands/pointerBridge'
import type { GestureName } from '@/core/types'

/**
 * A console handle on the parts of SHIVA that have no other way in (`?dev=1`).
 *
 * The hand-to-DOM bridge is the reason this exists. Its entire job is to make a
 * tracked hand indistinguishable from a mouse to code that was never written
 * with hands in mind, and the only way to know whether it does that is to drive
 * it against real DOM in a real browser. There is no camera in CI and no hands
 * in front of it, so without a way to say "the hand is here, and pinching",
 * the most failure-prone piece of the interaction stack would ship untested.
 *
 * It is also the fastest way for a person on real hardware to check a layout
 * without inventing a prompt for the brain first.
 *
 * Off unless asked for, following the same convention as `?capture=1` and
 * `?debug=hands`. It writes to the same singletons the tracking loop writes to,
 * so anything set here is overwritten the moment a real hand appears — which is
 * the correct precedence, and means leaving the flag on cannot wedge the
 * interface.
 */

export interface DevHand {
  /** Normalised video space, origin top-left — the same space MediaPipe reports. */
  x: number
  y: number
  z?: number
  gesture?: GestureName
  visible?: boolean
}

export interface ShivaDevHooks {
  /** Places the (right) hand and, unless told otherwise, hands it control. */
  hand: (hand: DevHand | null) => void
  /** Drives the DOM bridge directly, in CSS pixels. Bypasses projection. */
  pointer: typeof driveDomPointer
  bridge: typeof pointerBridgeState
  surfaces: {
    push: (content: SurfaceContent, id?: string) => string
    clear: () => void
    list: () => { id: string; kind: string }[]
  }
}

declare global {
  interface Window {
    __shiva?: ShivaDevHooks
  }
}

export function isDevHooksEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('dev') === '1'
}

export function installDevHooks(): void {
  if (typeof window === 'undefined') return

  window.__shiva = {
    hand: (hand) => {
      const right = handFrame.right
      if (!hand) {
        right.visible = false
        right.gesture = 'idle'
        handFrame.count = 0
        useGestureStore.getState().setInputMode('pointer')
        return
      }
      right.visible = hand.visible ?? true
      right.position.x = hand.x
      right.position.y = hand.y
      right.position.z = hand.z ?? 0
      // Tip tracks the palm here. The bridge only reads `position`, and a tip
      // that disagreed with it would be a lie waiting to confuse whoever reads
      // this next.
      right.tip.x = hand.x
      right.tip.y = hand.y
      right.tip.z = hand.z ?? 0
      right.gesture = hand.gesture ?? 'point'
      right.pinch = right.gesture === 'pinch' ? 1 : 0
      handFrame.count = right.visible ? 1 : 0
      useGestureStore.getState().setInputMode(right.visible ? 'hand' : 'pointer')
    },
    pointer: driveDomPointer,
    bridge: pointerBridgeState,
    surfaces: {
      push: (content, id) => useSurfaceStore.getState().push(content, id),
      clear: () => useSurfaceStore.getState().clear(),
      list: () =>
        useSurfaceStore.getState().surfaces.map((s) => ({ id: s.id, kind: s.content.kind })),
    },
  }
}
