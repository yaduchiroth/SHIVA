import type { HandMetrics } from './handFrame'

/**
 * Measures what the hand pipeline costs, separately from drawing it.
 *
 * This is a separate module from the cursor that feeds it for one reason: the
 * cursor cannot be tested. Its measurements only mean anything at a real frame
 * rate, and there is no GPU in CI — software rasterisation delivers frames
 * about twice a second, where `exp(-λ·dt)` is so deep into its tail that the
 * damp effectively teleports and every relationship being measured collapses.
 *
 * Pulled out here, the arithmetic can be driven at any frame rate you like
 * with positions you chose, and checked against a value derived independently
 * of it. That matters more than usual: this instrument exists to decide
 * whether smoothing is what makes the cursor feel wrong, and a wrong number
 * would send the next person tuning the wrong constants with confidence.
 *
 * **What the lag figure includes.** The drawn position is sampled before the
 * frame's damp, which means the comparison is between where the hand is now
 * and the cursor the eye is currently looking at — the one drawn last frame.
 * So the reading carries one frame of display delay on top of the smoothing,
 * and does not claim to be frame-rate independent. That is the honest form of
 * "the cursor trails my hand": on a machine drawing half as often, it does.
 *
 * The first thing it established, before any tuning: the render-loop damp
 * alone, at `INSTANT` and 60 fps, is 54 ms — and 64 ms at 30. The One Euro
 * filter upstream has not contributed anything at that point. Worth knowing
 * before touching a filter cutoff, because it means the second smoothing pass
 * in the cursor is the larger of the two costs, not the fine adjustment it
 * reads as.
 */

/**
 * Below this world-units-per-second, the hand counts as still.
 *
 * Two of the three measurements need it and they need opposite sides of it.
 * Lag is distance over speed, which means nothing as speed approaches zero — a
 * still hand with any residual offset divides it by almost nothing and reports
 * a lag no one experienced. Jitter is the reverse: it only means anything
 * while the hand is *not* moving, because during motion every sample is
 * dominated by the motion.
 */
export const STILL_SPEED = 0.35
/** Above this, the hand is moving enough for a lag figure to mean something. */
export const MOVING_SPEED = 1.2

/**
 * Smoothing on the readouts themselves.
 *
 * Low, because these are read by a person watching a HUD while moving their
 * hand, and digits that change every frame cannot be read at all. The cost is
 * that a reading needs a second or two of motion before it means anything,
 * which is the right trade for a diagnostic.
 */
export const METRIC_EMA = 0.08

/** Longer than any real camera-to-screen path; anything above is a clock fault. */
const IMPLAUSIBLE_MS = 1000

const ema = (previous: number, sample: number): number =>
  previous === 0 ? sample : previous * (1 - METRIC_EMA) + sample * METRIC_EMA

export interface Sample {
  /** Where the hand is now, world units. */
  targetX: number
  targetY: number
  targetZ: number
  /** Where the cursor is drawn, world units — before this frame's damp. */
  drawnX: number
  drawnY: number
  drawnZ: number
  /** The target in screen pixels, for the jitter figure. */
  screenX: number
  screenY: number
  /** Seconds since the previous sample. */
  dt: number
}

export class PipelineMeter {
  private lastTarget: [number, number, number] | null = null
  private lastScreen: [number, number] = [0, 0]
  private lastPose = 0

  reset(): void {
    this.lastTarget = null
    this.lastScreen = [0, 0]
    this.lastPose = 0
  }

  /**
   * Transport cost: the camera and the model.
   *
   * Counted once per pose rather than once per frame. Every frame would be
   * measuring how long the render loop has been redrawing the same pose, which
   * grows without bound between inferences and says nothing about the camera.
   *
   * @param poseTimestamp the pose's own timestamp, to detect a repeat
   * @param capturedAt `performance.now()` at capture, or 0 if unknown
   * @param now the current `performance.now()`
   */
  transport(out: HandMetrics, poseTimestamp: number, capturedAt: number, now: number): void {
    if (poseTimestamp === this.lastPose) return
    this.lastPose = poseTimestamp
    if (capturedAt <= 0) return
    const elapsed = now - capturedAt
    // A backgrounded tab, or a capture clock that has drifted, produces
    // figures no camera could have produced. Discarded rather than averaged
    // in, where a single outlier poisons the readout for seconds.
    if (elapsed <= 0 || elapsed >= IMPLAUSIBLE_MS) return
    out.pipelineMs = ema(out.pipelineMs, elapsed)
  }

  /** Smoothing cost, and the noise floor it is being spent on. */
  motion(out: HandMetrics, s: Sample): void {
    const screenDx = s.screenX - this.lastScreen[0]
    const screenDy = s.screenY - this.lastScreen[1]
    this.lastScreen = [s.screenX, s.screenY]

    const previous = this.lastTarget
    this.lastTarget = [s.targetX, s.targetY, s.targetZ]
    if (!previous || s.dt <= 0) return

    const moved = Math.hypot(
      s.targetX - previous[0],
      s.targetY - previous[1],
      s.targetZ - previous[2],
    )
    const speed = moved / s.dt

    if (speed > MOVING_SPEED) {
      const behind = Math.hypot(s.targetX - s.drawnX, s.targetY - s.drawnY, s.targetZ - s.drawnZ)
      // Distance over speed. The cursor is chasing a target moving at `speed`;
      // the gap between them is worth this many seconds of travel, which is
      // exactly what "it trails my hand by X ms" means.
      const lag = (behind / speed) * 1000
      if (lag < IMPLAUSIBLE_MS) out.lagMs = ema(out.lagMs, lag)
    } else if (speed < STILL_SPEED) {
      // In screen pixels rather than world units because that is the thing
      // being complained about: a wobble is only shake if you can see it, and
      // whether you can see it depends on the projection.
      out.jitterPx = ema(out.jitterPx, Math.hypot(screenDx, screenDy))
    }
  }
}
