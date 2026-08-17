'use client'

import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useSystemStore } from '@/core/store/useSystemStore'
import type { QualityTier } from '@/lib/device'

const ORDER: QualityTier[] = ['low', 'medium', 'high']

/**
 * Runtime quality governor.
 *
 * Device probing gives a starting tier, but it can only guess — a capable GPU
 * already driving two 4K displays will miss frames a benchmark wouldn't
 * predict. This measures what's actually happening and steps the tier down when
 * the budget is genuinely blown.
 *
 * Two properties matter for it not to be worse than nothing:
 *   - Downgrades need sustained evidence. Reacting to a single slow frame would
 *     drop quality every time the GC runs.
 *   - It never upgrades past the probed tier, and re-upgrading has a long
 *     cooldown. Oscillating between tiers is far more distracting than sitting
 *     one tier lower than optimal.
 */

const SAMPLE_FRAMES = 90 // ~1.5s at 60fps
// A frame-count-only window is a trap on exactly the machines this exists to
// help: at 4fps, 90 frames is twenty seconds before quality can drop. The
// window therefore closes on whichever comes first — enough frames, or enough
// time with at least a handful of samples to average over.
const SAMPLE_SECONDS = 1.5
const MIN_FRAMES = 4

const DOWNGRADE_FPS = 42
const UPGRADE_FPS = 58
const UPGRADE_COOLDOWN = 12_000 // ms

export function PerformanceGovernor() {
  const setPerf = useSystemStore((s) => s.setPerf)
  const setTier = useSystemStore((s) => s.setTier)
  const gl = useThree((s) => s.gl)

  const frames = useRef(0)
  const elapsed = useRef(0)
  const lastChange = useRef(0)
  const lastReport = useRef(0)

  useEffect(() => {
    // Report what actually got created, which may differ from what was probed.
    const ctx = gl.getContext()
    const ext = ctx.getExtension('WEBGL_debug_renderer_info')
    if (ext) {
      const renderer = String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      useSystemStore.setState({ renderer })
    }
  }, [gl])

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.5)
    frames.current += 1
    elapsed.current += dt

    const windowClosed =
      frames.current >= SAMPLE_FRAMES ||
      (elapsed.current >= SAMPLE_SECONDS && frames.current >= MIN_FRAMES)
    if (!windowClosed) return

    const fps = frames.current / elapsed.current
    const frameMs = (elapsed.current / frames.current) * 1000
    const now = performance.now()

    // Throttle store writes to ~2 Hz: the HUD can't usefully show more, and
    // every write re-renders its subscribers.
    if (now - lastReport.current > 500) {
      setPerf(Math.round(fps), Number(frameMs.toFixed(2)))
      lastReport.current = now
    }

    const { tier, baseTier, pinned } = useSystemStore.getState()
    const current = ORDER.indexOf(tier)

    // An explicitly pinned tier is an instruction, not a suggestion — keep
    // measuring and reporting, but never move it.
    if (pinned) {
      frames.current = 0
      elapsed.current = 0
      return
    }

    if (fps < DOWNGRADE_FPS && current > 0) {
      setTier(ORDER[current - 1]!)
      lastChange.current = now
    } else if (
      fps > UPGRADE_FPS &&
      current < ORDER.indexOf(baseTier) &&
      now - lastChange.current > UPGRADE_COOLDOWN
    ) {
      setTier(ORDER[current + 1]!)
      lastChange.current = now
    }

    frames.current = 0
    elapsed.current = 0
  })

  return null
}
