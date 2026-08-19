import { expect, test } from '@playwright/test'
import { OneEuroFilter } from '@/lib/one-euro'
import {
  PALM_FILTER,
  TIP_FILTER,
  PINCH_FILTER,
  GRAB_FILTER,
} from '@/spatial/hands/gestureRecognizer'

/**
 * What the smoothing costs, and what it buys.
 *
 * The filter constants were the reason the cursor trailed. `beta` is One Euro's
 * whole adaptive mechanism — it raises the cutoff as the hand speeds up, which
 * is how the filter removes lag during motion without giving up smoothing at
 * rest — and at 0.02, against hand speeds of one to three normalised units per
 * second, it raised the cutoff from 1.00 Hz to 1.06 Hz. The filter never left
 * its resting setting. That is the shape of the paper's pixel-space beta
 * applied to normalised coordinates, roughly a hundred times too small.
 *
 * These tests exist so the replacements are not the same mistake with
 * different numbers. Every value below is asserted against a measurement of
 * the real filter driven at inference rate, not against taste.
 *
 * **The trade is real, and it is not where it looks.** Raising beta appears
 * free if you measure noise with a stationary hand: it stays around a third of
 * the input across the entire useful range, because a still hand has almost no
 * derivative, so the cutoff never leaves `minCutoff` and beta is not engaged
 * at all. The cost only appears while the hand is *moving slowly* — reaching
 * for something — where the derivative is non-zero and the raised cutoff lets
 * more of the sensor's noise through. That is the case these tests measure,
 * because it is the case a person notices.
 */

/** Inference rate. The filters are stepped once per pose, not once per frame. */
const HZ = 30
const SAMPLES = 500
/** Discarded while the filter's two low-passes converge from their first sample. */
const WARMUP = 90

/**
 * MediaPipe's landmark noise, in normalised units.
 *
 * Only the noise *ratios* below depend on this, and a ratio through a linear
 * filter is independent of input amplitude — so nothing here rests on the
 * figure being exactly right.
 */
const NOISE = 0.003

/** Deterministic, because a filter test that fails one run in twenty is noise itself. */
function noiseSource() {
  let seed = 12345
  const uniform = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  // Six uniforms summed is close enough to Gaussian for a noise floor.
  return () => {
    let sum = 0
    for (let i = 0; i < 6; i++) sum += uniform()
    return (sum - 3) / Math.sqrt(0.5)
  }
}

const stdDev = (values: number[]): number => {
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)
}

/**
 * Steady-state lag against a target moving at a constant speed, in ms.
 *
 * Distance behind, divided by speed — the same definition the HUD's trail
 * figure uses, so the two numbers are directly comparable.
 */
function lagMs(config: { minCutoff: number; beta: number }, speed: number): number {
  const filter = new OneEuroFilter(config)
  let clean = 0
  let filtered = 0
  for (let i = 0; i < SAMPLES; i++) {
    const t = i / HZ
    clean = speed * t
    filtered = filter.filter(clean, t)
  }
  return ((clean - filtered) / speed) * 1000
}

/** Fraction of the sensor's noise that survives, with the hand held still. */
function noiseKeptAtRest(config: { minCutoff: number; beta: number }): number {
  const filter = new OneEuroFilter(config)
  const gauss = noiseSource()
  const input: number[] = []
  const output: number[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const t = i / HZ
    const value = gauss() * NOISE
    const out = filter.filter(value, t)
    if (i > WARMUP) {
      input.push(value)
      output.push(out)
    }
  }
  return stdDev(output) / stdDev(input)
}

/**
 * Fraction of the noise that survives while the hand also moves slowly.
 *
 * Measured as deviation from a straight line fitted to the filter's own
 * output, rather than against the clean input: the filter is deliberately
 * behind the input, so differencing the two would count its lag as wobble.
 * What a person sees on a steady sweep is departure from a steady sweep.
 */
function noiseKeptWhileMoving(config: { minCutoff: number; beta: number }, speed: number): number {
  const filter = new OneEuroFilter(config)
  const gauss = noiseSource()
  const points: { t: number; out: number }[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const t = i / HZ
    const out = filter.filter(speed * t + gauss() * NOISE, t)
    if (i > WARMUP) points.push({ t, out })
  }
  const meanT = points.reduce((s, p) => s + p.t, 0) / points.length
  const meanOut = points.reduce((s, p) => s + p.out, 0) / points.length
  let num = 0
  let den = 0
  for (const p of points) {
    num += (p.t - meanT) * (p.out - meanOut)
    den += (p.t - meanT) ** 2
  }
  const slope = num / den
  const intercept = meanOut - slope * meanT
  return stdDev(points.map((p) => p.out - (slope * p.t + intercept))) / NOISE
}

test.describe('the hand filters', () => {
  test('the palm keeps up with a moving hand', async () => {
    // Roughly: a slow reach, a normal move, a quick sweep across the frame.
    // The trail has to stay under a couple of frames at ordinary speeds — the
    // render-loop damp downstream spends about 54 ms of its own on top.
    expect(lagMs(PALM_FILTER, 0.5), 'slow reach').toBeLessThan(60)
    expect(lagMs(PALM_FILTER, 1.5), 'ordinary movement').toBeLessThan(30)
    expect(lagMs(PALM_FILTER, 3.0), 'quick sweep').toBeLessThan(20)
  })

  test('the palm is still smoothed where smoothing matters', async () => {
    // At rest, which is where sensor jitter is visible as shake and where a
    // fast filter would look broken. beta contributes nothing here by design.
    expect(noiseKeptAtRest(PALM_FILTER), 'a still hand must not shimmer').toBeLessThan(0.4)

    // And during a slow reach, which is the case that actually costs something.
    // The bound is the honest one: this is worse than it was, and the reason is
    // that the alternative was 138 ms of trail. In absolute terms it is a
    // fraction of a pixel of extra movement on a 1440-wide window.
    expect(noiseKeptWhileMoving(PALM_FILTER, 0.4), 'slow reach').toBeLessThan(0.6)
  })

  test('the fingertip tracks at least as closely as the palm', async () => {
    // It is the pointer. A tip that lags behind the palm it belongs to would
    // make pointing feel like aiming a trailing object.
    expect(lagMs(TIP_FILTER, 1.5)).toBeLessThanOrEqual(lagMs(PALM_FILTER, 1.5))
    expect(lagMs(TIP_FILTER, 1.5), 'ordinary movement').toBeLessThan(30)
  })

  test('a pinch registers within a frame or two of closing', async () => {
    // Pinch is a ratio, not a position: thumb-to-index over palm scale, which
    // travels from about 1.3 to 0.03 in the ~150 ms the gesture takes. Its
    // derivative is therefore an order of magnitude larger than the palm's,
    // and it needs its own beta rather than the palm's.
    //
    // What matters is not the filter's lag in the abstract but when the gate
    // actually trips, because that is the moment the interface responds.
    const GATE = 0.32
    const TRAVEL = 0.15

    const delay = (config: { minCutoff: number; beta: number }): number => {
      const filter = new OneEuroFilter(config)
      let cleanAt: number | null = null
      let filteredAt: number | null = null
      for (let i = 0; i < SAMPLES; i++) {
        const t = i / HZ
        const clean =
          t < 0.5 ? 1.3 : t < 0.5 + TRAVEL ? 1.3 - (1.3 - 0.03) * ((t - 0.5) / TRAVEL) : 0.03
        const out = filter.filter(clean, t)
        if (cleanAt === null && clean < GATE) cleanAt = t
        if (filteredAt === null && out < GATE) filteredAt = t
      }
      if (cleanAt === null || filteredAt === null) throw new Error('the gate never tripped')
      return (filteredAt - cleanAt) * 1000
    }

    // Two inference frames. Below that the measurement is quantised by the
    // 30 Hz sampling and asking for less would be asking for noise.
    expect(delay(PINCH_FILTER)).toBeLessThanOrEqual(1000 / HZ + 5)
  })

  test('every beta is sized for the signal it filters', async () => {
    // The bug this file exists for, stated as a property rather than as three
    // separate numbers: a beta small enough to leave the cutoff where it
    // started is not a tuning choice, it is a disabled filter. Each of these
    // must move its own cutoff materially at the speeds its own signal reaches.
    const engaged = (config: { minCutoff: number; beta: number }, typicalSpeed: number): number =>
      (config.minCutoff + config.beta * typicalSpeed) / config.minCutoff

    // Palm and tip see 1-3 normalised units/s; pinch and grab, being ratios
    // that collapse in a tenth of a second, see closer to 8.
    expect(engaged(PALM_FILTER, 1.5), 'palm beta is inert').toBeGreaterThan(2)
    expect(engaged(TIP_FILTER, 1.5), 'tip beta is inert').toBeGreaterThan(2)
    expect(engaged(PINCH_FILTER, 8), 'pinch beta is inert').toBeGreaterThan(2)
    expect(engaged(GRAB_FILTER, 8), 'grab beta is inert').toBeGreaterThan(2)
  })

  test('the old constants fail these tests', async () => {
    // Without this, every assertion above could be satisfied by a bound loose
    // enough to pass anything — which is exactly how the last rebrand check
    // passed twice with the bug live. The shipped values must be a genuine
    // improvement on what they replaced, not merely inside a wide box.
    const OLD_PALM = { minCutoff: 1.0, beta: 0.02 }
    expect(lagMs(OLD_PALM, 1.5), 'the old palm filter was fine after all?').toBeGreaterThan(100)
    expect(lagMs(PALM_FILTER, 1.5)).toBeLessThan(lagMs(OLD_PALM, 1.5) / 4)
  })
})
