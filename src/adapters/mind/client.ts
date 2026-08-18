'use client'

import { parseMindEvent, type MindEvent } from './protocol'

/**
 * The link to the mind.
 *
 * The mind binds its bus to `127.0.0.1:8765` on the Mac, which decides the shape of
 * this more than anything else does:
 *
 *   - Served from `http://localhost`, SHIVA connects and gets everything —
 *     the Claude brain, the companions, the Mac-bound tools. This is the desk.
 *   - Served from `https://shiva.drottnatech.com`, the browser **refuses** to
 *     open a `ws://` socket from a secure page. That is mixed-content blocking,
 *     it is not something a retry will fix, and it does not surface as a useful
 *     error — the socket just fails. So it is detected up front and reported as
 *     its own status, because "the mind is offline" would send someone to restart a
 *     process that is running perfectly.
 *
 * The fix for the hosted case is a TLS tunnel putting the bus on `wss://` and
 * `NEXT_PUBLIC_SHIVA_WS` pointing at it. That is a deployment choice, so the
 * client states the situation rather than deciding it.
 */

export type LinkStatus =
  /** Never asked to connect. */
  | { status: 'off' }
  | { status: 'connecting'; attempt: number }
  | { status: 'live'; url: string }
  /**
   * Nothing is listening, or the socket dropped.
   *
   * `nextRetryMs` of 0 means the client has stopped trying — see `MAX_ATTEMPTS`
   * — and will only reconnect when the tab is brought back to the foreground,
   * the network returns, or `retry()` is called.
   */
  | { status: 'unreachable'; detail: string; nextRetryMs: number }
  /** A secure page cannot open an insecure socket. Retrying will not help. */
  | { status: 'blocked'; detail: string }

export const DEFAULT_MIND_URL = 'ws://127.0.0.1:8765'

/**
 * Backoff bounds.
 *
 * The mind is a process on a laptop: it gets restarted, it gets killed, the lid
 * gets shut. Reconnecting is the normal case rather than the exception, so the
 * first retry is fast enough to be invisible during a restart, and the ceiling
 * is low enough that walking back to your desk does not mean waiting minutes
 * for the link to notice.
 */
const MIN_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 15_000

/**
 * Give up after roughly a minute of failure.
 *
 * Retrying forever is the obvious default and it is wrong here, for a reason
 * that only shows up on a machine that does not have the mind at all: Chromium logs
 * a console error for every refused WebSocket, from the network stack, where no
 * JavaScript can suppress it. An unbounded loop therefore prints an error every
 * fifteen seconds for as long as the tab is open, which buries anything real.
 *
 * Bounded, a machine without the mind gets eight lines and then quiet. The desk
 * keeps its "start the mind and it links itself" behaviour, because the window is
 * long enough to cover a restart — and because bringing the tab back to the
 * foreground or regaining the network starts a fresh window.
 */
const MAX_ATTEMPTS = 8

export interface MindClientOptions {
  url?: string
  onEvent: (event: MindEvent) => void
  onStatus: (status: LinkStatus) => void
  /** Kinds to receive. Null means everything. Defaults to all but the blobs. */
  kinds?: string[] | null
}

export class MindClient {
  private socket: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private closed = false
  private readonly url: string
  private kinds: string[] | null

  constructor(private readonly options: MindClientOptions) {
    this.url = options.url ?? DEFAULT_MIND_URL
    this.kinds = options.kinds === undefined ? null : options.kinds
  }

  /** True when this page cannot legally open this socket. */
  get blocked(): boolean {
    if (typeof window === 'undefined') return false
    return window.location.protocol === 'https:' && this.url.startsWith('ws://')
  }

  connect(): void {
    if (typeof window === 'undefined' || this.closed) return

    if (this.blocked) {
      this.options.onStatus({
        status: 'blocked',
        detail:
          `This page is served over HTTPS, and browsers refuse an insecure ${'ws://'} socket ` +
          `from a secure page. The mind may well be running. Reach it either by opening SHIVA at ` +
          `http://localhost, or by putting the bus behind a TLS tunnel and setting ` +
          `NEXT_PUBLIC_SHIVA_WS to its wss:// address.`,
      })
      return
    }

    this.options.onStatus({ status: 'connecting', attempt: this.attempt })

    let socket: WebSocket
    try {
      socket = new WebSocket(this.url)
    } catch (err) {
      // A malformed URL throws here rather than failing asynchronously, and it
      // is worth separating from "nothing is listening".
      this.fail(`Cannot open ${this.url}: ${(err as Error).message}`)
      return
    }
    this.socket = socket

    socket.onopen = () => {
      this.attempt = 0
      this.options.onStatus({ status: 'live', url: this.url })
      this.sendSubscription()
    }

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        // One malformed frame must not take the link down. The mind sends base64
        // image blobs on this socket; a truncated one is a dropped frame, not
        // a protocol failure.
        return
      }
      const odinEvent = parseMindEvent(parsed)
      if (odinEvent) this.options.onEvent(odinEvent)
    }

    // No `onerror` handler on purpose. Browsers deliberately give it no detail
    // — a reason string would let any page probe the local network — so
    // anything written here would be a guess. `onclose` always follows, and it
    // at least carries a code.

    socket.onclose = (event) => {
      this.socket = null
      if (this.closed) return
      this.fail(
        event.reason ||
          (event.code === 1006
            ? `Nothing is listening on ${this.url}. Is the mind running?`
            : `Link closed (${event.code}).`),
      )
    }
  }

  /**
   * Asks the mind for a subset of the feed. Null means everything.
   *
   * The mind's subscription is a WHITELIST — `kind not in subs` is dropped — so
   * trimming the camera and screen blobs means naming every kind you do want,
   * which also silently drops any kind the mind gains later. That trade is the
   * caller's to make: the default here is everything, because forward
   * compatibility is worth more than the bandwidth, and on localhost a 320px
   * JPEG a few times a second is not a bandwidth problem in the first place.
   * `lightKinds()` builds the trimmed whitelist for callers who do care.
   */
  setKinds(kinds: string[] | null): void {
    this.kinds = kinds
    this.sendSubscription()
  }

  private sendSubscription(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    // Sent even when null: a reconnecting socket inherits nothing, and saying
    // so explicitly is cheaper than reasoning about what the mind remembers.
    this.socket.send(JSON.stringify({ kind: 'subscribe', kinds: this.kinds }))
  }

  /** Sends a message back up the bus. The mind routes these to `on_client_message`. */
  send(message: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  private fail(detail: string): void {
    this.attempt++
    if (this.attempt >= MAX_ATTEMPTS) {
      this.options.onStatus({ status: 'unreachable', detail, nextRetryMs: 0 })
      return
    }
    const wait = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** this.attempt)
    // Jitter, so a Mac waking from sleep with several tabs open does not have
    // all of them hammer the same port on the same tick.
    const nextRetryMs = Math.round(wait * (0.7 + Math.random() * 0.6))
    this.options.onStatus({ status: 'unreachable', detail, nextRetryMs })
    this.timer = setTimeout(() => this.connect(), nextRetryMs)
  }

  /**
   * Starts a fresh attempt window after the client has given up.
   *
   * Called when the tab is brought back to the foreground or the network
   * returns — both are moments when the answer is likely to have changed — and
   * available to the HUD as an explicit action.
   */
  retry(): void {
    if (this.closed || this.socket || this.timer !== null) return
    this.attempt = 0
    this.connect()
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    const socket = this.socket
    this.socket = null
    // Detached first: `close()` fires `onclose`, which would otherwise schedule
    // a reconnect for a client that has just been told to stop.
    if (socket) {
      socket.onclose = null
      socket.onmessage = null
      socket.onerror = null
      socket.onopen = null
      socket.close()
    }
    this.options.onStatus({ status: 'off' })
  }
}

/** Where the mind is, if the deployment says. */
export function mindUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SHIVA_WS
  return configured && configured.trim() ? configured.trim() : DEFAULT_MIND_URL
}
