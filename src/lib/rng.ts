/**
 * Deterministic pseudo-random numbers.
 *
 * The orb is built from thousands of scattered positions, and `Math.random()`
 * would make every one of them different on every reload. That costs three
 * things worth having:
 *
 *   - a test can assert what the geometry is, because it is the same geometry;
 *   - a visual regression is attributable to the change that caused it rather
 *     than to that run's dice;
 *   - two clients looking at the same SHIVA see the same object, which starts
 *     to matter the moment anything is shared.
 *
 * mulberry32: 32-bit state, one multiply and a few shifts per draw, and a
 * period long enough that nothing here will see it. Fast enough to call tens of
 * thousands of times during scene construction without it registering.
 */
export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Uniform in [min, max). */
export const range = (rng: Rng, min: number, max: number): number => min + rng() * (max - min)

/**
 * A point on the unit sphere, uniformly distributed.
 *
 * The obvious version — random latitude, random longitude — is not uniform: it
 * bunches at the poles, because equal steps of latitude cover less area there.
 * Drawing `cos(phi)` uniformly instead of `phi` is the standard correction, and
 * the difference is very visible on a shell of a few hundred points.
 */
export function spherePoint(rng: Rng): [number, number] {
  const phi = Math.acos(2 * rng() - 1)
  const theta = rng() * Math.PI * 2
  return [phi, theta]
}
