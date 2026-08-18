'use client'

import { handFrame } from '@/core/hands/handFrame'
import { useGestureStore } from '@/core/store/useGestureStore'
import { useSurfaceStore, type SurfaceContent } from '@/core/store/useSurfaceStore'
import { driveDomPointer, pointerBridgeState } from '@/spatial/hands/pointerBridge'
import { parseMindEvent } from '@/adapters/mind/protocol'
import { useMindStore } from '@/core/store/useMindStore'
import { useBrainStore } from '@/core/store/useBrainStore'
import { speechFallbackReason, speechProvider } from '@/brain/speech'
import { handleMindEvent } from '@/adapters/mind/useMindLink'
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
  /**
   * Feeds a raw the mind wire message in as though it had arrived on the socket.
   *
   * The mind is a Python process on a Mac; there is neither one nor a Mac in CI.
   * Everything downstream of the socket — the parser's coercions, the surfaces
   * an event creates, the companion orbs it lights — is testable without one,
   * and this is how. It goes through `parseMindEvent` rather than around it, so
   * a test can hand it the same malformed payloads a real the mind occasionally
   * sends.
   */
  mind: (message: Record<string, unknown>) => boolean
  /**
   * The measured cost of the hand pipeline — see `HandMetrics`.
   *
   * Lives outside the store on purpose (it is written every frame), and the
   * HUD only shows it once tracking is genuinely active, which never happens
   * without a camera. Without this the instrument built to answer "is the
   * smoothing the problem" would itself be unverifiable.
   */
  metrics: () => { pipelineMs: number; lagMs: number; jitterPx: number }
  /**
   * A snapshot of the state that has no other way out.
   *
   * The orb's phase and the mind's link both live in stores read only by the WebGL
   * scene, which the DOM cannot see into. Without this, "did that event
   * actually change anything" is unanswerable from a test and from a console.
   */
  state: () => {
    phase: string
    mind: string
    link: string
    companions: { slug: string; state: string }[]
    /** Which voice last spoke, and why it was not the first choice. */
    voice: string
    voiceFallback: string | null
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
    state: () => {
      const mind = useMindStore.getState()
      return {
        phase: useBrainStore.getState().phase,
        mind: mind.state,
        link: mind.link.status,
        companions: mind.companions.map((c) => ({ slug: c.slug, state: c.state })),
        voice: speechProvider(),
        voiceFallback: speechFallbackReason(),
      }
    },
    metrics: () => ({
      pipelineMs: handFrame.metrics.pipelineMs,
      lagMs: handFrame.metrics.lagMs,
      jitterPx: handFrame.metrics.jitterPx,
    }),
    mind: (message) => {
      const event = parseMindEvent(message)
      if (!event) return false
      handleMindEvent(event)
      return true
    },
    surfaces: {
      push: (content, id) => useSurfaceStore.getState().push(content, id),
      clear: () => useSurfaceStore.getState().clear(),
      list: () =>
        useSurfaceStore.getState().surfaces.map((s) => ({ id: s.id, kind: s.content.kind })),
    },
  }
}
