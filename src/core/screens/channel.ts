'use client'

import type { Surface } from '@/core/store/useSurfaceStore'

/**
 * The link between SHIVA's two windows.
 *
 * `BroadcastChannel` rather than `postMessage` on the opener reference: the
 * display window survives the main one being reloaded, and a reload drops
 * `window.opener` on one side and `window.open`'s return value on the other.
 * A named channel is addressed by name, so either side can come and go and the
 * other reconnects without holding a handle to it.
 *
 * Surfaces travel as plain JSON, which they are — with one exception. A stream
 * surface carries no pixels: frames arrive from the mind five to ten times a
 * second and live outside React entirely (`adapters/odin/streams`). Pushing
 * those through here would be absurd, so the display window opens its own bus
 * subscription for them instead.
 */

export type ScreenMessage =
  /** A window announcing itself. Both sides send it on load. */
  | { type: 'hello'; role: 'main' | 'display' }
  /** Answer to a hello, so a window that loaded second still learns about the first. */
  | { type: 'here'; role: 'main' | 'display' }
  /** A window going away. */
  | { type: 'bye'; role: 'main' | 'display' }
  /** Main → display: take this. */
  | { type: 'send'; surface: Surface }
  /** Display → main: have it back. */
  | { type: 'return'; surface: Surface }
  /** Main → display: empty the wall. */
  | { type: 'clear' }

const CHANNEL = 'shiva:screens'

/**
 * How long a peer stays "present" without saying anything.
 *
 * A window closed by its title bar fires `pagehide`, but a crashed tab or a
 * killed browser process says nothing at all — so presence expires on its own
 * and the affordance disappears rather than offering to send surfaces into a
 * void. Heartbeats are cheap; two of them fit inside this.
 */
export const PEER_TIMEOUT_MS = 9000
export const HEARTBEAT_MS = 3000

export interface ScreenLink {
  /** True while the other window has been heard from recently. */
  peerPresent: () => boolean
  send: (message: ScreenMessage) => void
  close: () => void
}

/**
 * Opens the link. Returns a no-op link where `BroadcastChannel` is unavailable,
 * so callers never have to branch — the affordance simply never lights up.
 */
export function openScreenLink(
  role: 'main' | 'display',
  onMessage: (message: ScreenMessage) => void,
): ScreenLink {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return { peerPresent: () => false, send: () => {}, close: () => {} }
  }

  const channel = new BroadcastChannel(CHANNEL)
  let lastHeard = 0

  const post = (message: ScreenMessage) => channel.postMessage(message)

  channel.onmessage = (event: MessageEvent<ScreenMessage>) => {
    const message = event.data
    if (!message || typeof message !== 'object') return
    // A window only tracks the OTHER role. Without this a second display window
    // would count itself present and the main window would never notice it had
    // two peers — or, worse, a display would ping-pong `hello`/`here` with
    // another display forever.
    if ('role' in message && message.role === role) return

    if (message.type === 'hello') {
      lastHeard = Date.now()
      // Answered rather than ignored: whichever window loads second announces
      // itself, and this is how the one that loaded first finds out.
      post({ type: 'here', role })
    } else if (message.type === 'here') {
      lastHeard = Date.now()
    } else if (message.type === 'bye') {
      lastHeard = 0
    } else {
      lastHeard = Date.now()
    }

    onMessage(message)
  }

  post({ type: 'hello', role })
  const heartbeat = setInterval(() => post({ type: 'here', role }), HEARTBEAT_MS)

  // `pagehide` rather than `beforeunload`: the latter is not fired reliably on
  // mobile or when a tab is discarded, and it blocks the back/forward cache.
  const farewell = () => post({ type: 'bye', role })
  window.addEventListener('pagehide', farewell)

  return {
    peerPresent: () => lastHeard > 0 && Date.now() - lastHeard < PEER_TIMEOUT_MS,
    send: post,
    close: () => {
      post({ type: 'bye', role })
      clearInterval(heartbeat)
      window.removeEventListener('pagehide', farewell)
      channel.onmessage = null
      channel.close()
      lastHeard = 0
    },
  }
}
