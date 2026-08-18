'use client'

/**
 * Live JPEG frames from Odin, kept out of React entirely.
 *
 * Odin sends camera and screen frames as base64 JPEG inside JSON, several
 * times a second. Putting those in the surface store would be the obvious
 * thing and the wrong one: every frame would change the store's identity, which
 * re-renders the whole wall — every surface, its frame, its DOM — five to ten
 * times a second, to update one `<img>`.
 *
 * So frames land here and the stream surface sets `img.src` imperatively. Same
 * reasoning as `core/hands/handFrame.ts`: continuous values live outside the
 * store, discrete state lives in it. What goes in the store is only that a
 * stream EXISTS.
 */

export type StreamSource = 'camera' | 'screen'

export interface StreamFrame {
  /** A complete `data:` URL, ready to assign to an img. */
  src: string
  /** Faces Heimdall recognised in this frame. Empty for screen shares. */
  names: string[]
  at: number
}

type Listener = (frame: StreamFrame) => void

const latest = new Map<StreamSource, StreamFrame>()
const listeners = new Map<StreamSource, Set<Listener>>()

export function publishFrame(source: StreamSource, jpegBase64: string, names: string[] = []): void {
  if (!jpegBase64) return
  const frame: StreamFrame = {
    src: `data:image/jpeg;base64,${jpegBase64}`,
    names,
    at: Date.now(),
  }
  latest.set(source, frame)
  const set = listeners.get(source)
  if (!set) return
  for (const listener of set) {
    try {
      listener(frame)
    } catch (err) {
      // One misbehaving surface must not stop the others receiving frames —
      // the same rule the event bus applies for the same reason.
      console.error('[streams] listener threw:', err)
    }
  }
}

/** Subscribes to a source and immediately delivers the most recent frame. */
export function onFrame(source: StreamSource, listener: Listener): () => void {
  let set = listeners.get(source)
  if (!set) {
    set = new Set()
    listeners.set(source, set)
  }
  set.add(listener)
  // A surface mounted between frames would otherwise show nothing for up to a
  // fifth of a second, which reads as a stream that failed to start.
  const current = latest.get(source)
  if (current) listener(current)
  return () => {
    set.delete(listener)
  }
}

/** Drops everything. For unmount and for tests. */
export function resetStreams(): void {
  latest.clear()
  listeners.clear()
}
