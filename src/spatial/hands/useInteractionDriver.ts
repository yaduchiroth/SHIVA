'use client'

import { useEffect, useRef } from 'react'
import { on, emit } from '@/core/events/bus'
import { useSpatialStore } from '@/core/store/useSpatialStore'
import { useGestureStore } from '@/core/store/useGestureStore'
import { getPrimaryHand } from '@/core/hands/handFrame'
import { activeModuleIndex } from '@/core/store/useSpatialStore'

/**
 * Interaction policy.
 *
 * Deliberately separated from both the recognizer (which knows hand shapes but
 * nothing about the interface) and the carousel (which knows the interface but
 * nothing about hands). Every rule about what a gesture *means* lives here, in
 * one readable place, and both hand and pointer input converge on it.
 */
export function useInteractionDriver() {
  const focus = useSpatialStore((s) => s.focus)
  const setIdle = useSpatialStore((s) => s.setIdle)

  // Velocity at the moment of release, captured continuously while held —
  // by the time a release event fires the hand has usually already begun to
  // decelerate, so sampling then would under-read every throw.
  const heldVelocity = useRef({ x: 0, y: 0, z: 0 })
  const velocitySampler = useRef<number | null>(null)

  useEffect(() => {
    const offSwipe = on('gesture:swipe', ({ direction }) => {
      // A focused panel captures swipes: dismiss it rather than spinning the
      // ring underneath it.
      if (useSpatialStore.getState().focused !== null) {
        focus(null)
        return
      }
      emit('carousel:step', { direction })
    })

    const offStart = on('gesture:start', ({ gesture }) => {
      setIdle(false)
      const state = useSpatialStore.getState()

      if (gesture === 'pinch') {
        // Pinch on the front panel grabs it. Pinching while one is already held
        // is a no-op rather than a swap — grabbing a second panel mid-throw is
        // never what someone means.
        if (state.grabbed === null) {
          const index = activeModuleIndex(state.index)
          emit('panel:grab', { index, hand: 'right' })

          // Sample hand velocity on an interval while held.
          if (velocitySampler.current === null) {
            velocitySampler.current = window.setInterval(() => {
              const hand = getPrimaryHand()
              if (!hand?.visible) return
              // Tracking space → world: x is mirrored, y is inverted. Scaled to
              // world units; the raw normalised rate is far too small to throw.
              heldVelocity.current.x = -hand.velocity.x * 7
              heldVelocity.current.y = -hand.velocity.y * 7
              heldVelocity.current.z = hand.velocity.z * 3
            }, 40)
          }
        }
      }

      if (gesture === 'grab' && state.grabbed === null && state.focused === null) {
        // A closed fist expands the front panel to focus.
        focus(activeModuleIndex(state.index))
      }

      if (gesture === 'palm' && state.focused !== null) {
        // Open palm dismisses — the universal "stop / back" gesture.
        focus(null)
      }
    })

    const offEnd = on('gesture:end', ({ gesture }) => {
      const state = useSpatialStore.getState()
      if (gesture === 'pinch' && state.grabbed !== null) {
        if (velocitySampler.current !== null) {
          clearInterval(velocitySampler.current)
          velocitySampler.current = null
        }
        emit('panel:release', {
          index: state.grabbed,
          velocity: { ...heldVelocity.current },
        })
        heldVelocity.current = { x: 0, y: 0, z: 0 }
      }
    })

    return () => {
      offSwipe()
      offStart()
      offEnd()
      if (velocitySampler.current !== null) {
        clearInterval(velocitySampler.current)
        velocitySampler.current = null
      }
    }
  }, [focus, setIdle])

  // Focus is set from several places (gesture, click, keyboard), so the
  // corresponding events are published from one subscription to the store
  // rather than at each call site, where one would inevitably be missed.
  useEffect(() => {
    let previous = useSpatialStore.getState().focused
    return useSpatialStore.subscribe((state) => {
      if (state.focused === previous) return
      if (previous !== null) emit('panel:blur', { index: previous })
      if (state.focused !== null) emit('panel:focus', { index: state.focused })
      previous = state.focused
    })
  }, [])
}

/**
 * Whether an event originated in a text field.
 *
 * Global shortcuts and text entry share the keyboard, and the shortcuts here
 * call `preventDefault`, so without this check they don't merely fire
 * alongside typing — they actively break it.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

/**
 * Pointer and keyboard fallback.
 *
 * Not a lesser mode. Until the camera permission is granted — and on every
 * device without a usable camera — this *is* the interface, so it drives the
 * exact same events rather than a parallel implementation that drifts.
 */
export function usePointerFallback(enabled: boolean) {
  const focus = useSpatialStore((s) => s.focus)
  const setIdle = useSpatialStore((s) => s.setIdle)
  const inputMode = useGestureStore((s) => s.inputMode)

  const drag = useRef<{
    x: number
    time: number
    startIndex: number
    moved: boolean
  } | null>(null)
  const holdTimer = useRef<number | null>(null)
  const lastVelocity = useRef({ x: 0, y: 0, z: 0 })

  useEffect(() => {
    // Hands win when they're live; running both would double every action.
    if (!enabled || inputMode === 'hand') return

    /** Horizontal pixels equivalent to one panel of rotation. */
    const PX_PER_STEP = 220
    /** Movement beyond this is a drag, not a press. */
    const MOVE_SLOP = 8
    /** Press-and-hold this long without moving to grab. */
    const HOLD_MS = 340

    const clearHold = () => {
      if (holdTimer.current !== null) {
        clearTimeout(holdTimer.current)
        holdTimer.current = null
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      // A press on the HUD's own controls is not a press on the scene.
      if (e.target instanceof HTMLElement && e.target.closest('button, input, form')) return
      const state = useSpatialStore.getState()
      drag.current = {
        x: e.clientX,
        time: performance.now(),
        startIndex: state.index,
        moved: false,
      }
      setIdle(false)

      // Hold-to-grab is on a timer rather than a distance threshold. Using
      // distance would make every drag-to-rotate also grab a panel, which is
      // the opposite of what dragging is for.
      clearHold()
      holdTimer.current = window.setTimeout(() => {
        const current = useSpatialStore.getState()
        if (drag.current && !drag.current.moved && current.grabbed === null) {
          emit('panel:grab', { index: activeModuleIndex(current.index), hand: 'right' })
        }
      }, HOLD_MS)
    }

    const onPointerMove = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return

      const dx = e.clientX - d.x
      lastVelocity.current.x = (e.movementX / window.innerWidth) * 60
      lastVelocity.current.y = (-e.movementY / window.innerHeight) * 60

      if (!d.moved && Math.abs(dx) > MOVE_SLOP) {
        d.moved = true
        clearHold()
      }
      if (!d.moved) return

      // While grabbing, the panel follows the pointer (handled in Carousel) —
      // the ring stays put.
      if (useSpatialStore.getState().grabbed !== null) return

      // Continuous rotation: the ring tracks the pointer 1:1 rather than
      // waiting for the gesture to end. A carousel that only moves on release
      // feels like a slideshow, not an object being turned.
      useSpatialStore.getState().setIndex(d.startIndex - dx / PX_PER_STEP)
    }

    const onPointerUp = (e: PointerEvent) => {
      const d = drag.current
      drag.current = null
      clearHold()
      if (!d) return

      const dx = e.clientX - d.x
      const dt = performance.now() - d.time
      const state = useSpatialStore.getState()

      if (state.grabbed !== null) {
        emit('panel:release', { index: state.grabbed, velocity: { ...lastVelocity.current } })
        lastVelocity.current = { x: 0, y: 0, z: 0 }
        return
      }

      if (d.moved) {
        // Carry momentum on a flick, then settle on a whole panel — leaving the
        // ring at a fractional index would park two panels half-facing you.
        const velocity = dt > 0 ? -dx / PX_PER_STEP / (dt / 1000) : 0
        const momentum = Math.abs(velocity) > 1.2 ? Math.sign(velocity) : 0
        state.setIndex(Math.round(state.index + momentum))
        return
      }

      // No movement and quick: a click, which toggles focus.
      if (dt < HOLD_MS) {
        focus(state.focused === null ? activeModuleIndex(state.index) : null)
      }
    }

    const onWheel = (e: WheelEvent) => {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (Math.abs(delta) < 18) return
      emit('carousel:step', { direction: delta > 0 ? 1 : -1 })
    }

    const onKey = (e: KeyboardEvent) => {
      // Never steal keys from a text field. Without this, typing into the brain
      // console rotates the carousel on every arrow key, toggles focus on
      // Enter — so a message can never be sent — and swallows the space bar
      // entirely, because these handlers call preventDefault.
      if (isTextEntry(e.target)) return

      const state = useSpatialStore.getState()
      switch (e.key) {
        case 'ArrowLeft':
          emit('carousel:step', { direction: -1 })
          break
        case 'ArrowRight':
          emit('carousel:step', { direction: 1 })
          break
        case 'Enter':
        case ' ':
          e.preventDefault()
          focus(state.focused === null ? activeModuleIndex(state.index) : null)
          break
        case 'Escape':
          focus(null)
          break
        default:
          return
      }
      setIdle(false)
    }

    // Wheel is throttled by the browser but can still arrive faster than the
    // ring can travel; a trackpad flick would otherwise skip several panels.
    let wheelLock = 0
    const throttledWheel = (e: WheelEvent) => {
      const now = performance.now()
      if (now - wheelLock < 260) return
      wheelLock = now
      onWheel(e)
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    window.addEventListener('wheel', throttledWheel, { passive: true })
    window.addEventListener('keydown', onKey)

    return () => {
      clearHold()
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('wheel', throttledWheel)
      window.removeEventListener('keydown', onKey)
    }
  }, [enabled, inputMode, focus, setIdle])
}
