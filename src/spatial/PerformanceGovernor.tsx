'use client'

import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useSystemStore } from '@/core/store/useSystemStore'
import { decideTier } from './quality/governor'

/**
 * Runtime quality governor.
 *
 * Device probing gives a starting tier, but it can only guess — a capable GPU
 * already driving two 4K displays will miss frames a benchmark wouldn't predict.
 * This measures what's actually happening.
 *
 * Measuring only. Every judgement lives in `quality/governor.ts` as a pure
 * function, because the version that lived in this closure was untested and got
 * it badly wrong: it treated the seconds a GPU spends compiling shaders on first
 * render as evidence about the machine, and walked the tier from high to low
 * before the boot sequence had finished. Since `trackingHz` is tied to the tier,
 * that also dropped hand sampling to a third of the rate the gesture thresholds
 * were calibrated for — so the recognizer looked broken too.
 */

const SAMPLE_FRAMES = 90 // ~1.5s at 60fps
// A frame-count-only window is a trap on exactly the machines this exists to
// help: at 4fps, 90 frames is twenty seconds before quality can drop. The
// window therefore closes on whichever comes first — enough frames, or enough
// time with at least a handful of samples to average over.
const SAMPLE_SECONDS = 1.5
const MIN_FRAMES = 4

export function PerformanceGovernor() {
  const setPerf = useSystemStore((s) => s.setPerf)
  const setTier = useSystemStore((s) => s.setTier)
  const gl = useThree((s) => s.gl)

  const frames = useRef(0)
  const elapsed = useRef(0)
  const lastChange = useRef(0)
  const lastReport = useRef(0)
  const slowWindows = useRef(0)
  /** When the scene began rendering — the clock the warm-up gate runs on. */
  const startedAt = useRef(0)

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
    // Stamped on the very first frame, not on the first closed window — the
    // window takes over a second to close, and starting the warm-up clock then
    // would silently shift the gate later than it reads.
    if (startedAt.current === 0) startedAt.current = performance.now()
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

    const decision = decideTier({
      fps,
      tier,
      baseTier,
      pinned,
      msSinceStart: now - startedAt.current,
      // Before the first change, measure from start — otherwise every early
      // window would look like it had just followed one.
      msSinceChange: now - (lastChange.current || startedAt.current),
      slowWindows: slowWindows.current,
    })

    slowWindows.current = decision.slowWindows

    if (decision.action !== 'hold') {
      setTier(decision.tier)
      // Recorded so the HUD can say the tier was MOVED rather than merely being
      // low — a distinction that, when missing, cost an afternoon of looking at
      // the renderer instead of at this file.
      useSystemStore.setState({ tierReason: decision.reason })
      lastChange.current = now
    }

    frames.current = 0
    elapsed.current = 0
  })

  return null
}
