'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { openScreenLink, type ScreenLink, type ScreenMessage } from '@/core/screens/channel'
import { hasExtendedDisplay, openDisplayWindow, type OpenResult } from '@/core/screens/placement'
import { useSurfaceStore } from '@/core/store/useSurfaceStore'
import { useSurfaceDrag } from './useSurfaceDrag'

/**
 * The main window's half of the two-screen arrangement.
 *
 * Owns the channel, tells the drag hook whether there is anywhere to throw a
 * surface, and knows whether opening a display window is even worth offering.
 *
 * Presence is polled rather than pushed into React on every heartbeat: the
 * peer sends one every three seconds, and re-rendering the HUD on each of them
 * to change nothing is a waste. A second is fast enough for a button to appear.
 */
export interface Screens {
  /** True when a second display is attached — no permission needed to know. */
  extended: boolean
  /** True while the display window is open and answering. */
  connected: boolean
  open: () => Promise<OpenResult>
  link: ScreenLink | null
}

export function useScreens(): Screens {
  const [extended, setExtended] = useState(false)
  const [connected, setConnected] = useState(false)
  const link = useRef<ScreenLink | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setExtended(hasExtendedDisplay())

    const handle = openScreenLink('main', (message: ScreenMessage) => {
      if (message.type === 'return') {
        // Coming home. `attach` filters by id first, so a surface sent across
        // and back does not arrive beside a stale copy of itself.
        useSurfaceStore.getState().attach(message.surface)
      }
    })
    link.current = handle
    setReady(true)

    const poll = setInterval(() => setConnected(handle.peerPresent()), 1000)
    return () => {
      clearInterval(poll)
      handle.close()
      link.current = null
      setReady(false)
    }
  }, [])

  useSurfaceDrag(ready ? link.current : null, () => link.current?.peerPresent() ?? false)

  const open = useCallback(async () => {
    const result = await openDisplayWindow()
    // Optimistic: the window announces itself over the channel within a beat,
    // but the button should stop offering to open it immediately.
    if (result.placed !== 'blocked') setConnected(true)
    return result
  }, [])

  return { extended, connected, open, link: link.current }
}
