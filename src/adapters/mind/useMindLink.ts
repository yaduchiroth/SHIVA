'use client'

import { useEffect } from 'react'
import { useBrainStore } from '@/core/store/useBrainStore'
import { useMindStore } from '@/core/store/useMindStore'
import { useSurfaceStore } from '@/core/store/useSurfaceStore'
import { emit } from '@/core/events/bus'
import { MindClient, mindUrl } from './client'
import { publishFrame, resetStreams } from './streams'
import { setMindClient } from './link'
import type { MindEvent } from './protocol'

/**
 * Connects to the mind and turns its events into SHIVA.
 *
 * This is the seam the whole merge runs through. The mind keeps its Python
 * capabilities — the Claude brain, the companions, the Mac-bound tools — and
 * SHIVA becomes its only face. Everything the mind used to draw into a flat HTML
 * HUD arrives here instead and becomes a surface in the room, an orbiting
 * companion, or a change in the orb.
 *
 * Deliberately one-way at this layer. Events come in and land in stores; going
 * the other way is `sendToMind`, which the brain client calls. Keeping the two
 * directions separate means a flood of events can never turn into a feedback
 * loop of replies.
 */

/** The mind has five states; SHIVA's orb has four. `acting` is a kind of thinking. */
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
 * configured deployment. Set `NEXT_PUBLIC_SHIVA_WS` to a `wss://` address to
 * link a hosted SHIVA to a tunnelled the mind.
 */
function shouldConnect(url: string): boolean {
  if (typeof window === 'undefined') return false
  if (new URLSearchParams(window.location.search).get('mind') === 'off') return false
  return window.location.protocol !== 'https:' || url.startsWith('wss://')
}

/**
 * Turns one the mind event into SHIVA state.
 *
 * Module scope rather than a closure inside the hook so it can be driven
 * directly — by the test suite through `window.__shiva.mind`, and by anything
 * later that replays a recorded session. A handler reachable only from inside a
 * live WebSocket is a handler that can only be tested with a live WebSocket.
 */
export function handleMindEvent(event: MindEvent): void {
  const mindStore = useMindStore.getState()
  const surfaceStore = useSurfaceStore.getState()

  switch (event.kind) {
    case 'state':
      mindStore.setState(event.value)
      // One source of truth for the orb: whatever brain is answering, the
      // avatar reads its phase from the same place.
      useBrainStore.getState().setPhase(toPhase(event.value))
      break

    case 'odinmode':
      mindStore.setAwake(event.value === 'awake')
      break

    case 'log':
      mindStore.appendLog(event.text)
      break

    case 'transcript':
      // the mind echoes the user's own turn back as a transcript event. Pushing
      // that would duplicate every typed message, since the console already
      // recorded it locally when it was sent.
      if (event.who === 'user') break
      useBrainStore.getState().pushAssistant(event.text)
      break

    case 'presence':
      mindStore.setPresence(event.name, event.known)
      // Someone arriving is worth a visible reaction from the avatar before
      // anyone has said anything — a surge through the orb and an audio blip.
      //
      // Deliberately NOT `brain:wake`, which sounds right and is not: that
      // event opens the text input and focuses it, so Nandi noticing you
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
      mindStore.setRoster(event.items)
      break

    case 'dispatch':
      mindStore.dispatch(event.id, event.slug, event.task)
      break

    case 'companion':
      mindStore.setCompanionState(event.slug, event.state)
      break

    case 'dispatch_return':
      mindStore.returnDispatch(event.id, event.slug, event.ok)
      break

    case 'dispatch_clear':
      mindStore.clearDispatch()
      break

    case 'devices':
    case 'iot':
      mindStore.setDevices(event.items)
      // Kept in one surface with a stable id, so a device changing state
      // refreshes the panel in place instead of stacking another copy of the
      // same list onto the wall.
      surfaceStore.push(
        { kind: 'connectors', title: 'Connectors', items: event.items },
        'mind-connectors',
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
          title: event.kind === 'camera' ? 'Nandi' : 'Drishti',
          source: event.kind,
        },
        `mind-${event.kind}`,
      )
      break
    }

    case 'unknown':
      // A newer the mind talking to an older SHIVA. Logged rather than ignored,
      // because "the mind did something and nothing happened" is otherwise
      // impossible to diagnose from this side.
      mindStore.appendLog(`unhandled event: ${event.name}`)
      break
  }
}

export function useMindLink(): void {
  useEffect(() => {
    const url = mindUrl()
    if (!shouldConnect(url)) return

    const client = new MindClient({
      url,
      onStatus: (status) => {
        useMindStore.getState().setLink(status)
        if (status.status === 'live') {
          useMindStore.getState().appendLog(`linked to the mind at ${status.url}`)
        }
        if (status.status === 'off' || status.status === 'unreachable') {
          // Companions cannot still be out on errands if the link is down. The
          // alternative is orbs left spinning at "working" forever, which reads
          // as the mind being busy rather than absent.
          useMindStore.getState().clearDispatch()
        }
      },
      onEvent: handleMindEvent,
    })

    setMindClient(client)
    client.connect()

    // Two moments when the answer is likely to have changed, and the client has
    // probably stopped trying by now: the tab coming back to the foreground
    // after the mind was started at the desk, and the network returning after a
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
      setMindClient(null)
      client.close()
      useMindStore.getState().reset()
      resetStreams()
    }
  }, [])
}
