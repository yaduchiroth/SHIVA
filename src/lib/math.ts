export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export const inverseLerp = (a: number, b: number, v: number): number =>
  a === b ? 0 : (v - a) / (b - a)

export const remap = (v: number, inMin: number, inMax: number, outMin: number, outMax: number) =>
  lerp(outMin, outMax, clamp(inverseLerp(inMin, inMax, v), 0, 1))

export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

/**
 * Frame-rate independent exponential smoothing.
 *
 * `lerp(current, target, 0.1)` in a render loop is the classic bug: it converges
 * twice as fast at 120fps as at 60fps, so the whole interface feels different on
 * different machines. `lambda` here is a rate (higher = snappier) and the result
 * is identical regardless of frame rate.
 */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(target, current, Math.exp(-lambda * dt))

/** Shortest signed angular distance from `a` to `b`, in radians. */
export const angleDelta = (a: number, b: number): number => {
  const d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  return d < -Math.PI ? d + Math.PI * 2 : d
}

/** Angular damp that takes the short way around the circle. */
export const dampAngle = (current: number, target: number, lambda: number, dt: number): number =>
  current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt))

/**
 * Hysteresis gate. A gesture that triggers and releases on the same threshold
 * strobes when the signal sits near it — pinch flickering on/off 20 times a
 * second. Requiring a stronger signal to enter than to exit fixes it.
 */
export class Schmitt {
  private state = false

  constructor(
    private readonly enter: number,
    private readonly exit: number,
  ) {}

  /** @returns the gate state after applying `value`. */
  update(value: number): boolean {
    // `enter < exit` means the signal triggers when it drops below a threshold
    // (as with pinch distance); otherwise it triggers when it rises above one.
    this.state =
      this.enter < this.exit
        ? this.state
          ? value < this.exit
          : value < this.enter
        : this.state
          ? value > this.exit
          : value > this.enter
    return this.state
  }

  get active(): boolean {
    return this.state
  }

  reset(): void {
    this.state = false
  }
}
