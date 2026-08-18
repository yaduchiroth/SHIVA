'use client'

import { useEffect, useRef } from 'react'
import { useSurfaceStore } from '@/core/store/useSurfaceStore'
import { emit } from '@/core/events/bus'
import type { ScreenLink } from '@/core/screens/channel'

/**
 * Dragging a surface, and throwing it at the other display.
 *
 * Listens on `window` rather than on the surface, which is what makes one
 * implementation serve both input methods: the hand bridge dispatches genuine
 * pointer events that bubble here exactly as the mouse's do. There is no hand
 * path and no mouse path, only a pointer path — which is the same reason
 * `usePointerFallback` exists and the same reason the two cannot drift apart.
 *
 * Grabbing is by the surface's header, not by its body. A surface whose whole
 * face is a drag handle cannot contain a scrollable report or a working button,
 * and a modifier key is not available to a hand. The title bar is the idiom
 * every windowing system already taught everyone.
 */

/**
 * How far past the right edge of the viewport a surface must be dragged.
 *
 * A fraction rather than pixels, so it means the same thing on a laptop panel
 * and a 6K display. 0.82 is far enough that you cannot reach it while reading
 * something on the right of the wall, near enough that it is not a stretch.
 */
export const DOCK_THRESHOLD = 0.82

export interface DragState {
  /** Fraction of the viewport the pointer is at. 0,0 is the top-left corner. */
  x: number
  y: number
  /** True once past DOCK_THRESHOLD with something in hand. */
  overDock: boolean
}

/**
 * Read by the dock edge and the held surface, so neither re-renders per frame.
 *
 * Same reasoning as `handFrame`: a pointer during a drag moves at frame rate,
 * and routing that through React would re-render every surface — content,
 * iframes and all — on every move.
 */
const state: DragState = { x: 0, y: 0, overDock: false }
export const dragState = (): Readonly<DragState> => state

export function useSurfaceDrag(link: ScreenLink | null, peerPresent: () => boolean): void {
  const grabbed = useSurfaceStore((s) => s.grabbed)
  const latest = useRef({ grabbed, link, peerPresent })
  latest.current = { grabbed, link, peerPresent }

  useEffect(() => {
    /**
     * Whether letting go right now would send the surface across.
     *
     * Reads the store directly rather than the React-rendered value, so the
     * answer is current even when a press and a release land inside one tick.
     */
    const dockable = () =>
      useSurfaceStore.getState().grabbed !== null &&
      state.x > DOCK_THRESHOLD &&
      latest.current.peerPresent()

    const onMove = (event: PointerEvent) => {
      state.x = event.clientX / Math.max(1, window.innerWidth)
      state.y = event.clientY / Math.max(1, window.innerHeight)
      state.overDock = dockable()
    }

    const onUp = () => {
      // Decided here rather than read from the last move. Two ordinary things
      // break the cached version: a surface grabbed and released without moving
      // at all, and — because React flushes the grab on its own schedule — a
      // move that arrived in the same tick as the press, before the store knew
      // anything was held. Both present as the dock quietly not working.
      const docked = dockable()
      const { grabbed: held, link: channel } = latest.current
      state.overDock = false
      if (held === null) return

      const store = useSurfaceStore.getState()
      store.setGrabbed(null)
      emit('surface:release', { id: held })
      if (!docked || !channel) return

      const surface = store.detach(held)
      if (!surface) return
      channel.send({ type: 'send', surface })
      emit('surface:sent', { id: held })
      emit('ui:confirm', { intensity: 0.8 })
    }

    // Capture phase, so a release is seen even when the element under the
    // pointer stops propagation — a surface dropped onto a report's own
    // scroll container would otherwise stay stuck to the hand forever.
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    return () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
    }
  }, [])
}
