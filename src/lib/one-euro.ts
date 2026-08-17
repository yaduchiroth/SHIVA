/**
 * One Euro filter — Casiez, Roussel & Vogel (CHI 2012).
 *
 * MediaPipe's landmarks jitter by a few millimetres even when a hand is
 * perfectly still. A fixed low-pass filter can remove that jitter but adds
 * constant lag, which makes fast gestures feel like dragging through syrup.
 *
 * One Euro adapts its cutoff to speed: heavy smoothing when the hand is still
 * (jitter disappears), light smoothing when it moves fast (lag disappears).
 * This single choice is most of the difference between "cheap webcam demo" and
 * "this feels like it's tracking my actual hand".
 */

class LowPass {
  private value: number | null = null

  filter(x: number, alpha: number): number {
    this.value = this.value === null ? x : alpha * x + (1 - alpha) * this.value
    return this.value
  }

  get last(): number | null {
    return this.value
  }

  reset(): void {
    this.value = null
  }
}

export interface OneEuroConfig {
  /** Baseline cutoff in Hz. Lower = smoother at rest, but slower to start moving. */
  minCutoff?: number
  /** How aggressively cutoff rises with speed. Higher = less lag when moving fast. */
  beta?: number
  /** Cutoff for the derivative estimate itself. Rarely needs tuning. */
  dCutoff?: number
}

export class OneEuroFilter {
  private readonly minCutoff: number
  private readonly beta: number
  private readonly dCutoff: number
  private readonly x = new LowPass()
  private readonly dx = new LowPass()
  private lastTime: number | null = null

  constructor({ minCutoff = 1.2, beta = 0.02, dCutoff = 1 }: OneEuroConfig = {}) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.dCutoff = dCutoff
  }

  /** @param timestamp seconds */
  filter(value: number, timestamp: number): number {
    // Fall back to 60 Hz for the first sample, and clamp pathological dt from
    // tab-backgrounding — a 4-second dt would otherwise make alpha ~1 and let a
    // full frame of jitter through unfiltered.
    let dt = this.lastTime === null ? 1 / 60 : timestamp - this.lastTime
    if (!(dt > 0) || dt > 0.25) dt = 1 / 60
    this.lastTime = timestamp

    const rate = 1 / dt
    const prev = this.x.last
    const derivative = prev === null ? 0 : (value - prev) * rate
    const edx = this.dx.filter(derivative, alpha(rate, this.dCutoff))

    // The adaptive step: cutoff scales with the magnitude of movement.
    const cutoff = this.minCutoff + this.beta * Math.abs(edx)
    return this.x.filter(value, alpha(rate, cutoff))
  }

  reset(): void {
    this.x.reset()
    this.dx.reset()
    this.lastTime = null
  }
}

function alpha(rate: number, cutoff: number): number {
  const tau = 1 / (2 * Math.PI * cutoff)
  const te = 1 / rate
  return 1 / (1 + tau / te)
}

/** Convenience wrapper for filtering a 3D point with shared tuning. */
export class OneEuroVec3 {
  private readonly fx: OneEuroFilter
  private readonly fy: OneEuroFilter
  private readonly fz: OneEuroFilter

  constructor(config?: OneEuroConfig) {
    this.fx = new OneEuroFilter(config)
    this.fy = new OneEuroFilter(config)
    this.fz = new OneEuroFilter(config)
  }

  filter(
    out: { x: number; y: number; z: number },
    x: number,
    y: number,
    z: number,
    timestamp: number,
  ): void {
    out.x = this.fx.filter(x, timestamp)
    out.y = this.fy.filter(y, timestamp)
    out.z = this.fz.filter(z, timestamp)
  }

  reset(): void {
    this.fx.reset()
    this.fy.reset()
    this.fz.reset()
  }
}
