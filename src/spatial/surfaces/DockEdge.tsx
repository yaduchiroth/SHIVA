'use client'

import { useEffect, useRef } from 'react'
import { useSurfaceStore } from '@/core/store/useSurfaceStore'
import { dragState } from './useSurfaceDrag'

/**
 * The glowing edge that says a surface will go to the other display.
 *
 * Painted in the DOM rather than in the scene: it belongs to the frame, not to
 * the room, and a full-height gradient is one composited element instead of
 * geometry the renderer has to think about.
 *
 * Its opacity is written imperatively from a rAF loop. The alternative —
 * React state driven by pointer moves — re-renders on every frame of a drag,
 * which is the exact cost the whole surface layer is arranged to avoid.
 */
export function DockEdge({ connected }: { connected: boolean }) {
  const edge = useRef<HTMLDivElement>(null)
  const grabbed = useSurfaceStore((s) => s.grabbed)

  useEffect(() => {
    if (grabbed === null || !connected) {
      if (edge.current) edge.current.style.opacity = '0'
      return
    }
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = edge.current
      if (!el) return
      const { x, overDock } = dragState()
      // Fades in as the surface approaches rather than snapping at the
      // threshold, so the edge is a target you can see coming rather than a
      // trap you fall into.
      const approach = Math.max(0, Math.min(1, (x - 0.6) / 0.22))
      el.style.opacity = String(overDock ? 1 : approach * 0.55)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [grabbed, connected])

  return (
    <div
      ref={edge}
      aria-hidden
      data-testid="dock-edge"
      className="pointer-events-none fixed inset-y-0 right-0 z-20 flex w-32 items-center justify-end pr-4 opacity-0 transition-opacity duration-150"
      style={{
        background:
          'linear-gradient(to right, transparent, color-mix(in srgb, var(--color-signal) 22%, transparent))',
      }}
    >
      <span
        className="text-[10px] tracking-[0.28em] whitespace-nowrap uppercase"
        style={{ color: 'var(--color-signal)', writingMode: 'vertical-rl' }}
      >
        Display 2 →
      </span>
    </div>
  )
}
