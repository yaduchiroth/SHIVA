import type { GestureName, Handedness, Vec3 } from '@/core/types'

/**
 * Typed event bus for discrete interaction events.
 *
 * The point of this indirection: gestures are produced in exactly one place
 * (the recognizer) and consumed in several that must not know about each other
 * — the carousel rotates, physics grabs, audio fires a transient, the HUD
 * flashes. It also gives the pointer fallback a way to drive the identical
 * downstream behaviour, so a mouse and a hand are genuinely interchangeable
 * rather than two parallel code paths that drift apart.
 *
 * In Phase 2 the Gemini brain publishes intents onto this same bus.
 */

export interface EventMap {
  'gesture:start': { hand: Handedness; gesture: GestureName; position: Vec3 }
  'gesture:end': { hand: Handedness; gesture: GestureName; position: Vec3 }
  /** Emitted once per swipe, with direction sign and peak speed. */
  'gesture:swipe': { hand: Handedness; direction: -1 | 1; speed: number }
  /** A grab began on a panel. */
  'panel:grab': { index: number; hand: Handedness }
  /** Released, with the throw velocity in world units/sec. */
  'panel:release': { index: number; velocity: Vec3 }
  'panel:focus': { index: number }
  'panel:blur': { index: number }
  'carousel:step': { direction: -1 | 1 }
  /** Any UI affordance that wants a confirmation blip. */
  'ui:confirm': { intensity: number }
  'tracking:acquired': { hands: number }
  'tracking:lost': Record<string, never>
  /** A circle traced in the air — the gestural equivalent of the wake word. */
  'brain:wake': { hand: Handedness }
}

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void

const handlers = new Map<keyof EventMap, Set<Handler<never>>>()

export function on<K extends keyof EventMap>(event: K, handler: Handler<K>): () => void {
  let set = handlers.get(event)
  if (!set) {
    set = new Set()
    handlers.set(event, set)
  }
  set.add(handler as Handler<never>)
  return () => {
    set.delete(handler as Handler<never>)
  }
}

export function emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
  const set = handlers.get(event)
  if (!set) return
  for (const handler of set) {
    try {
      ;(handler as Handler<K>)(payload)
    } catch (err) {
      // One misbehaving listener must not stop the others — a thrown error in
      // the audio engine should never freeze the carousel.
      console.error(`[bus] handler for "${event}" threw:`, err)
    }
  }
}

/** Test/HMR hygiene: drop every registration. */
export function clearBus(): void {
  handlers.clear()
}
