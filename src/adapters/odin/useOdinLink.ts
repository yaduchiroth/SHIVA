'use client'

import { useEffect } from 'react'
import { useBrainStore } from '@/core/store/useBrainStore'
import { useOdinStore } from '@/core/store/useOdinStore'
import { useSurfaceStore } from '@/core/store/useSurfaceStore'
import { emit } from '@/core/events/bus'
import { OdinClient, odinUrl } from './client'
import { publishFrame, resetStreams } from './streams'
import { setOdinClient } from './link'
import type { OdinEvent } from './protocol'

/**
 * Connects to Odin and turns its events into SHIVA.
 *
 * This is the seam the whole merge runs through. Odin keeps its Python
 * capabilities — the Claude brain, the companions, the Mac-bound tools — and
 * SHIVA becomes its only face. Everything Odin used to draw into a flat HTML
 * HUD arrives here instead and becomes a surface in the room, an orbiting
 * companion, or a change in the orb.
 *
 * Deliberately one-way at this layer. Events come in and land in stores; going
 * the other way is `sendToOdin`, which the brain client calls. Keeping the two
 * directions separate means a flood of events can never turn into a feedback
 * loop of replies.
 */

/** Odin has five states; SHIVA's orb has four. `acting` is a kind of thinking. */
function toPhase(state: string): 'idle' | 'listening' | 'thinking' | 'speaking' {
  if (state === 'listening') return 'listening'
  if (state === 'speaking') return 'speaking'
  if (state === 'thinking' || state === 'acting') return 'thinking'
  return 'idle'
}

/**
 * Whether to try connecting at all.
 *
 * Off by default on a hosted page: `ws://127.0.0.1` from `https://` is blocked
 * by the browser and cannot be made to work, so attempting it would spend a
 * reconnect loop achieving nothing and report an error for a correctly
 * configured deployment. Set `NEXT_PUBLIC_ODIN_WS` to a `wss://` address to
 * link a hosted SHIVA to a tunnelled Odin.
 */
function shouldConnect(url: string): boolean {
  if (typeof window === 'undefined') return false
  if (new URLSearchParams(window.location.search).get('odin') === 'off') return false
  return window.location.protocol !== 'https:' || url.startsWith('wss://')
}

/**
 * Turns one Odin event into SHIVA state.
 *
 * Module scope rather than a closure inside the hook so it can be driven
 * directly — by the test suite through `window.__shiva.odin`, and by anything
 * later that replays a recorded session. A handler reachable only from inside a
 * live WebSocket is a handler that can only be tested with a live WebSocket.
 */
export function handleOdinEvent(event: OdinEvent): void {
  const odinStore = useOdinStore.getState()
  const surfaceStore = useSurfaceStore.getState()

  switch (event.kind) {
    case 'state':
      odinStore.setState(event.value)
      // One source of truth for the orb: whatever brain is answering, the
      // avatar reads its phase from the same place.
      useBrainStore.getState().setPhase(toPhase(event.value))
      break

    case 'odinmode':
      odinStore.setAwake(event.value === 'awake')
      break

    case 'log':
      odinStore.appendLog(event.text)
      break

    case 'transcript':
      // Odin echoes the user's own turn back as a transcript event. Pushing
      // that would duplicate every typed message, since the console already
      // recorded it locally when it was sent.
      if (event.who === 'user') break
      useBrainStore.getState().pushAssistant(event.text)
      break

    case 'presence':
      odinStore.setPresence(event.name, event.known)
      // Someone arriving is worth a visible reaction from the avatar before
      // anyone has said anything — a surge through the orb and an audio blip.
      //
      // Deliberately NOT `brain:wake`, which sounds right and is not: that
      // event opens the text input and focuses it, so Heimdall noticing you
      // walk past would pop a keyboard prompt open every time.
      emit('ui:confirm', { intensity: event.known ? 1 : 0.45 })
      break

    case 'card':
      surfaceStore.push({ kind: 'card', title: event.title, body: event.body })
      break

    case 'raven':
      surfaceStore.push({ kind: 'card', title: event.title, body: event.body })
      break

    case 'report':
      surfaceStore.push({ kind: 'report', title: event.title, html: event.html })
      break

    case 'chart':
      surfaceStore.push({
        kind: 'chart',
        title: event.title,
        ctype: event.ctype,
        labels: event.labels,
        series: event.series,
        unit: event.unit,
      })
      break

    case 'webview':
      surfaceStore.push({ kind: 'web', url: event.url, title: event.title })
      break

    case 'wellclear':
      surfaceStore.clear()
      break

    case 'roster':
      odinStore.setRoster(event.items)
      break

    case 'dispatch':
      odinStore.dispatch(event.id, event.slug, event.task)
      break

    case 'companion':
      odinStore.setCompanionState(event.slug, event.state)
      break

    case 'dispatch_return':
      odinStore.returnDispatch(event.id, event.slug, event.ok)
      break

    case 'dispatch_clear':
      odinStore.clearDispatch()
      break

    case 'devices':
    case 'iot':
      odinStore.setDevices(event.items)
      // Kept in one surface with a stable id, so a device changing state
      // refreshes the panel in place instead of stacking another copy of the
      // same list onto the wall.
      surfaceStore.push(
        { kind: 'connectors', title: 'Connectors', items: event.items },
        'odin-connectors',
      )
      break

    case 'camera':
    case 'screen': {
      // Pixels go to the stream channel, not the store: a base64 JPEG landing
      // in Zustand five times a second would re-render every surface on the
      // wall to update one image. The store learns only that a feed exists.
      publishFrame(event.kind, event.jpg, event.kind === 'camera' ? event.names : [])
      surfaceStore.push(
        {
          kind: 'stream',
          title: event.kind === 'camera' ? 'Heimdall' : 'Mimir',
          source: event.kind,
        },
        `odin-${event.kind}`,
      )
      break
    }

    case 'unknown':
      // A newer Odin talking to an older SHIVA. Logged rather than ignored,
      // because "Odin did something and nothing happened" is otherwise
      // impossible to diagnose from this side.
      odinStore.appendLog(`unhandled event: ${event.name}`)
      break
  }
}

export function useOdinLink(): void {
  useEffect(() => {
    const url = odinUrl()
    if (!shouldConnect(url)) return

    const client = new OdinClient({
      url,
      onStatus: (status) => {
        useOdinStore.getState().setLink(status)
        if (status.status === 'live') {
          useOdinStore.getState().appendLog(`linked to Odin at ${status.url}`)
        }
        if (status.status === 'off' || status.status === 'unreachable') {
          // Companions cannot still be out on errands if the link is down. The
          // alternative is orbs left spinning at "working" forever, which reads
          // as Odin being busy rather than absent.
          useOdinStore.getState().clearDispatch()
        }
      },
      onEvent: handleOdinEvent,
    })

    setOdinClient(client)
    client.connect()

    // Two moments when the answer is likely to have changed, and the client has
    // probably stopped trying by now: the tab coming back to the foreground
    // after Odin was started at the desk, and the network returning after a
    // sleep. Both start a fresh attempt window rather than a permanent loop.
    const wake = () => {
      if (document.visibilityState === 'visible') client.retry()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    window.addEventListener('focus', wake)

    return () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      window.removeEventListener('focus', wake)
      setOdinClient(null)
      client.close()
      useOdinStore.getState().reset()
      resetStreams()
    }
  }, [])
}
