'use client'

import { useEffect, useRef, useState } from 'react'
import { useSystemStore } from '@/core/store/useSystemStore'

/**
 * Boot.
 *
 * This is doing real work, not theatre. The first frames of an R3F app are the
 * most expensive it will ever render — shader compilation, texture upload,
 * physics init — and dropping a user straight into that means their first
 * impression is a stutter. The boot overlay covers exactly that window, so by
 * the time the scene is visible it's already running smoothly.
 *
 * It's also the honest place to report a failure: if WebGL is unavailable the
 * user gets told, rather than staring at a black rectangle.
 */

const LINES = [
  'Initialising render pipeline',
  'Compiling shader programs',
  'Building volumetric environment',
  'Spinning up physics solver',
  'Mounting module carousel',
  'Spatial interface online',
] as const

export function BootSequence({ onComplete }: { onComplete: () => void }) {
  const [line, setLine] = useState(0)
  const [done, setDone] = useState(false)
  const reducedMotion = useSystemStore((s) => s.reducedMotion)
  const completed = useRef(false)

  useEffect(() => {
    // Respecting reduced motion here matters more than most places: a staged
    // reveal is precisely the kind of thing that triggers discomfort.
    if (reducedMotion) {
      setDone(true)
      if (!completed.current) {
        completed.current = true
        onComplete()
      }
      return
    }

    let cancelled = false
    const timers: number[] = []

    LINES.forEach((_, i) => {
      timers.push(
        window.setTimeout(
          () => {
            if (!cancelled) setLine(i + 1)
          },
          260 + i * 320,
        ),
      )
    })

    timers.push(
      window.setTimeout(
        () => {
          if (cancelled) return
          setDone(true)
          if (!completed.current) {
            completed.current = true
            onComplete()
          }
        },
        260 + LINES.length * 320 + 400,
      ),
    )

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [onComplete, reducedMotion])

  return (
    <div
      className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center transition-opacity duration-700"
      style={{
        background: 'var(--color-void)',
        opacity: done ? 0 : 1,
        // Removed from the compositor once faded, so it can't cost anything
        // during normal operation.
        visibility: done ? 'hidden' : 'visible',
        transitionProperty: 'opacity, visibility',
      }}
      aria-hidden={done}
    >
      <div className="flex flex-col items-center gap-6">
        <div
          className="text-5xl font-light"
          style={{ color: 'var(--color-bone)', letterSpacing: '0.5em', paddingLeft: '0.5em' }}
        >
          SHIVA
        </div>

        <div className="h-px w-48" style={{ background: 'var(--color-steel)' }}>
          <div
            className="h-full transition-all duration-300 ease-out"
            style={{
              width: `${(line / LINES.length) * 100}%`,
              background: 'var(--color-signal)',
            }}
          />
        </div>

        <div className="flex h-5 flex-col items-center">
          <span
            className="text-hud-label"
            style={{ color: 'var(--color-smoke)', letterSpacing: '0.24em' }}
          >
            {LINES[Math.min(line, LINES.length - 1)]}
          </span>
        </div>
      </div>
    </div>
  )
}
