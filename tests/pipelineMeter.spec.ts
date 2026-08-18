import { expect, test } from '@playwright/test'
import { handFrame, type HandMetrics } from '@/core/hands/handFrame'
import { METRIC_EMA, PipelineMeter } from '@/core/hands/pipelineMeter'
import { INSTANT } from '@/core/config/motion'
import { damp } from '@/lib/math'

/**
 * The instrument, checked against arithmetic rather than against itself.
 *
 * This matters more than a typical test. The meter exists to decide whether
 * smoothing is what makes the cursor feel wrong, and a diagnostic that is
 * quietly wrong is worse than none: it is believed, and it sends whoever reads
 * it to tune the wrong constants with confidence.
 *
 * So none of these compare the meter to a number the meter produced. The lag
 * figure is checked against a closed form — a first-order lag chasing a target
 * at constant velocity settles exactly `1/λ` seconds behind it, whatever the
 * velocity and whatever the frame rate — and the rest against values that can
 * be worked out on paper.
 *
 * Runs in Node, with the frame loop simulated, because the real one cannot
 * help here: CI has no GPU and software rasterisation delivers frames about
 * twice a second, where `dt` is ten times `1/λ` and the discrete damp bears no
 * resemblance to the continuous ideal it approximates.
 */

const fresh = (): HandMetrics => ({ capturedAt: 0, pipelineMs: 0, lagMs: 0, jitterPx: 0 })

/** Enough frames for an EMA at `METRIC_EMA` to be within a percent of its input. */
const SETTLE_FRAMES = Math.ceil(5 / METRIC_EMA)

/**
 * Runs a cursor damping toward a target moving at constant speed, and returns
 * what the meter made of it.
 */
function sweep({
  fps,
  speed,
  lambda = INSTANT,
  frames = SETTLE_FRAMES,
}: {
  fps: number
  speed: number
  lambda?: number
  frames?: number
}): HandMetrics {
  const meter = new PipelineMeter()
  const out = fresh()
  const dt = 1 / fps
  let targetX = 0
  // Starts converged. Beginning at rest would spend the first few 1/λ catching
  // up, and those frames measure the approach rather than the steady state.
  let drawnX = 0

  for (let i = 0; i < frames; i++) {
    targetX += speed * dt
    meter.motion(out, {
      targetX,
      targetY: 0,
      targetZ: 0,
      drawnX,
      drawnY: 0,
      drawnZ: 0,
      screenX: 0,
      screenY: 0,
      dt,
    })
    drawnX = damp(drawnX, targetX, lambda, dt)
  }
  return out
}

/**
 * What a damp at `lambda`, stepped at `fps`, actually lags by — in ms.
 *
 * The obvious prediction is `1/λ`, and it is wrong. That is the *continuous*
 * steady state, the limit as dt approaches zero; at 60 fps and λ=22 it
 * under-predicts by 19%. The first version of this test asserted it and the
 * meter failed against it, which was the test being wrong, not the meter.
 *
 * The discrete recurrence is `x ← x + (T − x)(1 − a)` with `a = e^(−λ·dt)`,
 * and the target advancing `v·dt` per step. At steady state the gap left after
 * a step is `g = v·dt·a/(1−a)`; the meter samples *before* the step, so it
 * sees `g + v·dt`, and dividing by `v` gives `dt/(1−a)` — with the velocity
 * cancelling, which is why the reading does not depend on how fast the hand
 * moves.
 *
 * Sampling before the step is deliberate rather than incidental: the cursor
 * the eye is looking at is the one drawn last frame, so comparing it against
 * where the hand is now includes the frame of display delay the user actually
 * experiences. It is the honest number for "the cursor trails my hand", and it
 * is why the reading is not frame-rate independent — a slower machine really
 * does trail further.
 */
const predictedLagMs = (fps: number, lambda = INSTANT): number => {
  const dt = 1 / fps
  return (dt / (1 - Math.exp(-lambda * dt))) * 1000
}

test.describe('the pipeline meter', () => {
  test('reads the lag a first-order damp is known to produce', async () => {
    const predicted = predictedLagMs(60)

    // Three speeds, because the velocity cancels out of the closed form. If
    // the meter were really reporting distance rather than time, these would
    // differ by 4x.
    for (const speed of [2, 4, 8]) {
      const out = sweep({ fps: 60, speed })
      expect(out.lagMs, `at ${speed} units/s`).toBeGreaterThan(predicted * 0.97)
      expect(out.lagMs, `at ${speed} units/s`).toBeLessThan(predicted * 1.03)
    }
  })

  test('tracks the frame rate the way the arithmetic says it should', async () => {
    // Not frame-rate independent, and it should not be: the reading includes
    // the frame of display delay, so a slower machine genuinely trails
    // further. What matters is that it moves *by the predicted amount* — 64 ms
    // at 30 fps against 50 at 120 — rather than being some number that merely
    // rises when frames get scarcer.
    for (const fps of [30, 60, 120]) {
      const out = sweep({ fps, speed: 4 })
      const predicted = predictedLagMs(fps)
      expect(out.lagMs, `at ${fps} fps, expected ~${predicted.toFixed(0)} ms`).toBeGreaterThan(
        predicted * 0.97,
      )
      expect(out.lagMs, `at ${fps} fps`).toBeLessThan(predicted * 1.03)
    }
  })

  test('moves when the damp rate moves', async () => {
    // The property that makes it useful for tuning: it has to respond, in the
    // right direction and by the right amount, when the constant it is
    // measuring changes. Otherwise it is a plausible-looking constant.
    const tight = sweep({ fps: 60, speed: 4, lambda: INSTANT })
    const loose = sweep({ fps: 60, speed: 4, lambda: INSTANT / 2 })
    expect(loose.lagMs).toBeGreaterThan(tight.lagMs)
    // Against the closed form again rather than against a round ratio —
    // halving λ does not quite double the reading, because the frame of
    // display delay in it does not scale with λ at all.
    const ratio = predictedLagMs(60, INSTANT / 2) / predictedLagMs(60, INSTANT)
    expect(loose.lagMs / tight.lagMs).toBeGreaterThan(ratio * 0.97)
    expect(loose.lagMs / tight.lagMs).toBeLessThan(ratio * 1.03)
  })

  test('a still hand has no trail, however far the cursor has to catch up', async () => {
    // The dangerous failure: lag is distance over speed, and as speed
    // approaches zero that ratio explodes. A hand resting on a desk would
    // report hundreds of milliseconds of trail and send someone tuning filters
    // to fix a problem that does not exist.
    const meter = new PipelineMeter()
    const out = fresh()
    for (let i = 0; i < 200; i++) {
      meter.motion(out, {
        targetX: 1,
        targetY: 0,
        targetZ: 0,
        // Deliberately a long way behind, which is the worst case for the
        // division: a large numerator over a speed of nothing.
        drawnX: 0,
        drawnY: 0,
        drawnZ: 0,
        screenX: 0,
        screenY: 0,
        dt: 1 / 60,
      })
    }
    expect(out.lagMs).toBe(0)
  })

  test('measures shake only while the hand is still, in pixels', async () => {
    // Two pixels of wobble, alternating, with the hand otherwise stationary.
    const meter = new PipelineMeter()
    const out = fresh()
    for (let i = 0; i < SETTLE_FRAMES; i++) {
      meter.motion(out, {
        targetX: 0,
        targetY: 0,
        targetZ: 0,
        drawnX: 0,
        drawnY: 0,
        drawnZ: 0,
        screenX: i % 2 === 0 ? 0 : 2,
        screenY: 0,
        dt: 1 / 60,
      })
    }
    expect(out.jitterPx).toBeGreaterThan(1.8)
    expect(out.jitterPx).toBeLessThan(2.2)
  })

  test('does not report shake during a sweep', async () => {
    // Movement is not shake. Without the speed gate every fast gesture would
    // register as a jitter spike, and the number that is supposed to say
    // "the sensor is noisy" would instead say "you moved your hand".
    const out = sweep({ fps: 60, speed: 8 })
    expect(out.jitterPx).toBe(0)
  })

  test('counts transport once per pose, not once per frame', async () => {
    // The render loop runs several times per inference. Counting every frame
    // would measure how long the same pose has been on screen — a number that
    // grows without bound between inferences and says nothing about the camera.
    const meter = new PipelineMeter()
    const out = fresh()
    const captured = 1000
    // One pose, redrawn ten times, each 16 ms later than the last.
    for (let i = 0; i < 10; i++) meter.transport(out, 5, captured, captured + 40 + i * 16)
    expect(out.pipelineMs).toBe(40)
  })

  test('discards a capture time no camera could have produced', async () => {
    // A backgrounded tab resumes with a capture timestamp from before the
    // pause. Averaged in, one such sample dominates the readout for seconds.
    const meter = new PipelineMeter()
    const out = fresh()
    meter.transport(out, 1, 1000, 1040)
    const clean = out.pipelineMs
    meter.transport(out, 2, 1000, 1000 + 30_000)
    expect(out.pipelineMs).toBe(clean)
  })

  test('reports nothing at all when the capture clock is unavailable', async () => {
    // Firefox has no `requestVideoFrameCallback`. Better a blank readout than
    // a confident wrong one.
    const meter = new PipelineMeter()
    const out = fresh()
    for (let i = 0; i < 50; i++) meter.transport(out, i, 0, 5000 + i)
    expect(out.pipelineMs).toBe(0)
  })

  test('the shared frame starts and resets with nothing measured', async () => {
    // Zero is how the HUD knows to render a dash rather than a figure, so it
    // has to mean "not measured" everywhere, including after tracking stops.
    expect(handFrame.metrics.pipelineMs).toBe(0)
    expect(handFrame.metrics.lagMs).toBe(0)
    expect(handFrame.metrics.jitterPx).toBe(0)
  })
})
