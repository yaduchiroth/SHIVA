'use client'

import type { OdinClient } from './client'

/**
 * The one live link to Odin, reachable without prop drilling.
 *
 * Same pattern, and the same justification, as `spatial/hands/videoSource.ts`:
 * exactly one of these exists per page, several unrelated places need it, and
 * threading it through React would mean every one of them re-rendering when the
 * socket reconnects. The hook owns the lifetime; this is only the handle.
 */

let client: OdinClient | null = null

export function setOdinClient(next: OdinClient | null): void {
  client = next
}

/** True when Odin is connected and would accept a message right now. */
export function odinLinked(): boolean {
  return client !== null
}

/**
 * Sends a turn to Odin's Claude brain.
 *
 * `text_input` is Odin's own inbound protocol (`__main__.on_client_message`) —
 * the same message its HUD sends when you type into it. The reply does not come
 * back on this call: it arrives asynchronously as `transcript` and `state`
 * events, plus whatever surfaces the brain decides to put in the room. That
 * asymmetry is the protocol's, not a limitation here, and it is why the caller
 * gets a boolean rather than a promise of an answer.
 *
 * @returns false when the socket is not open, so the caller can fall back.
 */
export function sendToOdin(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return client?.send({ kind: 'text_input', text: trimmed }) ?? false
}

/** Push-to-talk: asks Odin's own microphone to start listening. */
export function triggerOdinEars(): boolean {
  return client?.send({ kind: 'trigger_ears' }) ?? false
}
