'use client'

import { useEffect, useRef, useState } from 'react'
import { openScreenLink, type ScreenLink, type ScreenMessage } from '@/core/screens/channel'
import { useSurfaceStore } from '@/core/store/useSurfaceStore'
import { OdinClient, odinUrl } from '@/adapters/odin/client'
import { publishFrame } from '@/adapters/odin/streams'
import { SurfaceBody } from './content/SurfaceBody'

/**
 * SHIVA's second window.
 *
 * Deliberately not the interface. No orb, no carousel, no hand tracking — there
 * is one camera and it belongs to the window you are actually looking at, and
 * running a second WebGL scene to display a report would be paying for the
 * atmosphere twice. This is a wall of surfaces at full size, which is what a
 * second monitor is for.
 *
 * It keeps its own connection to the mind, but subscribed to `camera` and
 * `screen` only. That is the entire reason `OdinClient.setKinds` exists: a live
 * feed is pixels arriving ten times a second and cannot travel over the window
 * channel, while every other event must NOT be handled here or each report the
 * mind published would appear on both walls at once.
 */
export function DisplayShell() {
  const surfaces = useSurfaceStore((s) => s.surfaces)
  const [linked, setLinked] = useState(false)
  const link = useRef<ScreenLink | null>(null)

  useEffect(() => {
    const handle = openScreenLink('display', (message: ScreenMessage) => {
      const store = useSurfaceStore.getState()
      if (message.type === 'send') store.attach(message.surface)
      else if (message.type === 'clear') store.clear()
    })
    link.current = handle
    const poll = setInterval(() => setLinked(handle.peerPresent()), 1000)
    return () => {
      clearInterval(poll)
      handle.close()
      link.current = null
    }
  }, [])

  useEffect(() => {
    const url = odinUrl()
    if (
      typeof window !== 'undefined' &&
      window.location.protocol === 'https:' &&
      url.startsWith('ws://')
    ) {
      return
    }
    const client = new OdinClient({
      url,
      // Frames only. Anything else arriving here would duplicate the main
      // window's wall onto this one.
      kinds: ['camera', 'screen'],
      onStatus: () => {},
      onEvent: (event) => {
        if (event.kind === 'camera') publishFrame('camera', event.jpg, event.names)
        else if (event.kind === 'screen') publishFrame('screen', event.jpg)
      },
    })
    client.connect()
    return () => client.close()
  }, [])

  return (
    <main className="relative h-full w-full overflow-hidden bg-[var(--color-void)]">
      <header className="pointer-events-none absolute top-5 left-6 z-10 flex items-baseline gap-3">
        <span
          className="text-sm tracking-[0.42em]"
          style={{ color: 'var(--color-bone)' }}
          data-testid="display-brand"
        >
          SHIVA
        </span>
        <span className="text-[10px] tracking-[0.24em] text-[var(--color-smoke)] uppercase">
          Display 2 · {linked ? 'linked' : 'waiting'}
        </span>
      </header>

      {surfaces.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
          <p className="text-[11px] tracking-[0.26em] text-[var(--color-signal-dim)] uppercase">
            Nothing here yet
          </p>
          <p className="max-w-md text-[13px] text-[var(--color-smoke)]">
            Drag a surface to the right-hand edge of the main window and let go.
          </p>
        </div>
      ) : (
        <div
          className="grid h-full auto-rows-fr gap-5 p-8 pt-16"
          style={{
            // One surface fills the display; two sit side by side; more tile.
            // Fixed columns would waste most of a 27-inch panel on one report.
            gridTemplateColumns: `repeat(${Math.min(surfaces.length, 3)}, minmax(0, 1fr))`,
          }}
          data-testid="display-wall"
        >
          {surfaces.map((surface) => (
            <section
              key={surface.id}
              data-testid="display-surface"
              data-surface-id={surface.id}
              data-surface-kind={surface.content.kind}
              className="flex min-h-0 flex-col overflow-hidden rounded-sm border border-[var(--color-steel)] bg-[var(--color-abyss)]/70"
            >
              <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-steel)] px-4 py-2.5">
                <span className="truncate text-[11px] tracking-[0.22em] text-[var(--color-signal-dim)] uppercase">
                  {surface.content.title || surface.content.kind}
                </span>
                <span className="flex-1" />
                <button
                  type="button"
                  className="px-1 text-[10px] tracking-[0.18em] text-[var(--color-smoke)] uppercase hover:text-[var(--color-bone)]"
                  data-testid="display-return"
                  onClick={() => {
                    const returned = useSurfaceStore.getState().detach(surface.id)
                    if (returned) link.current?.send({ type: 'return', surface: returned })
                  }}
                >
                  Send back
                </button>
              </header>
              <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-5">
                <SurfaceBody content={surface.content} />
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  )
}
