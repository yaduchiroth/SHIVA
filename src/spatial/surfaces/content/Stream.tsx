'use client'

import { useEffect, useRef, useState } from 'react'
import { onFrame, type StreamSource } from '@/adapters/mind/streams'

/**
 * A live JPEG feed, updated without re-rendering.
 *
 * `img.src` is assigned imperatively from a plain subscription rather than
 * being driven by state. Frames arrive five to ten times a second, and routing
 * each through React would re-render this surface — and, because the store's
 * identity would change, every other surface on the wall — to change one
 * attribute.
 *
 * The staleness notice matters more than it looks. A stream that stops sending
 * leaves its last frame on screen, indefinitely and convincingly: a still image
 * of an empty chair is indistinguishable from a live view of an empty chair.
 */

/** No frame for this long and the picture is history, not a view. */
const STALE_MS = 4000

const LABEL: Record<StreamSource, string> = {
  camera: 'Nandi',
  screen: 'Drishti',
}

export function Stream({ source }: { source: StreamSource }) {
  const img = useRef<HTMLImageElement>(null)
  const [names, setNames] = useState<string[]>([])
  const [stale, setStale] = useState(true)
  const lastFrame = useRef(0)

  useEffect(() => {
    const off = onFrame(source, (frame) => {
      if (img.current) img.current.src = frame.src
      lastFrame.current = frame.at
      setStale(false)
      // Only written when it changes: recognised names are stable across
      // frames, and setting identical state ten times a second is the cost
      // this component exists to avoid.
      setNames((previous) =>
        previous.length === frame.names.length && previous.every((n, i) => n === frame.names[i])
          ? previous
          : frame.names,
      )
    })
    const timer = window.setInterval(() => {
      if (lastFrame.current && Date.now() - lastFrame.current > STALE_MS) setStale(true)
    }, 1000)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [source])

  return (
    <div className="relative h-full w-full" data-testid="stream">
      {/* eslint-disable-next-line @next/next/no-img-element -- the src is a
          data: URL replaced imperatively many times a second; next/image is for
          static assets and would allocate a new loader per frame. */}
      <img ref={img} alt={`${LABEL[source]} feed`} className="h-full w-full object-contain" />

      {names.length > 0 ? (
        <p className="absolute top-2 left-2 text-[10px] tracking-[0.2em] text-[var(--color-nominal)] uppercase">
          {names.join(' · ')}
        </p>
      ) : null}

      {stale ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-[var(--color-abyss)]/80">
          <p className="text-[10px] tracking-[0.2em] text-[var(--color-caution)] uppercase">
            No signal
          </p>
          <p className="text-[11px] text-[var(--color-smoke)]">
            {lastFrame.current ? 'The feed stopped sending.' : `Waiting for ${LABEL[source]}…`}
          </p>
        </div>
      ) : null}
    </div>
  )
}
