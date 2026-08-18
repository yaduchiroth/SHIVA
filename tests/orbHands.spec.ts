import { expect, test } from '@playwright/test'
import {
  deriveAperture,
  deriveSpread,
  driveOrbFromHands,
  type HandSample,
} from '@/spatial/orb/handDrive'
import { MAX_HANDS, handToOrb, orbDrive, resetOrbDrive } from '@/spatial/orb/orbDrive'
import {
  DRIFT,
  EASE,
  GLIDE,
  HANDS_REST_SEPARATION,
  INSTANT,
  ORB_HAND_REACH,
  ORB_PUSH_FALLOFF,
  ORB_PUSH_STRENGTH,
  SETTLE,
  SNAP,
} from '@/core/config/motion'

/**
 * The orb's response to hands.
 *
 * The visual result can only be judged on a machine with a GPU, so what is
 * tested is the part that decides whether it will be right: where a hand lands
 * in the orb's own space, what counts as "at rest", and the falloff that stops
 * a particle sitting under your hand from being flung out of the scene.
 */

const hand = (over: Partial<HandSample> = {}): HandSample => ({
  visible: true,
  x: 0.5,
  y: 0.5,
  z: 0,
  openness: 0,
  grab: 0,
  vx: 0,
  ...over,
})

/** Runs the driver for `seconds` at 60 Hz, so damped values actually settle. */
const settle = (hands: readonly [HandSample | null, HandSample | null], seconds = 1) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) driveOrbFromHands(hands, 1 / 60)
}

test.describe('tracking space to orb space', () => {
  test('the centre of the frame is the centre of the orb', () => {
    const out = new Float32Array(4)
    handToOrb(out, 0, 0.5, 0.5, 0, ORB_HAND_REACH)
    expect(out[0]).toBeCloseTo(0, 6)
    expect(out[1]).toBeCloseTo(0, 6)
  })

  test('x is mirrored and y inverted, matching the cursor', () => {
    // The feed is shown mirrored because an un-mirrored self-view feels broken,
    // and video counts down while the world counts up. If this disagreed with
    // hands/projection.ts, the orb would part on the opposite side from the
    // visible cursor — which would look like a bug in the tracking.
    const out = new Float32Array(4)
    handToOrb(out, 0, 0.8, 0.8, 0, ORB_HAND_REACH)
    expect(out[0]).toBeLessThan(0)
    expect(out[1]).toBeLessThan(0)
  })

  test('a hand at the frame edge reaches past the shell', () => {
    // The shell is radius 2.0. The hand has to be able to get outside it, or
    // there is no approach — the influence sphere would start already inside.
    const out = new Float32Array(4)
    handToOrb(out, 0, 0, 0.5, 0, ORB_HAND_REACH)
    expect(Math.abs(out[0]!)).toBeGreaterThan(2)
  })

  test('depth is scaled well below x and y', () => {
    // MediaPipe's z is a rough wrist-relative offset. Trusting it as far as the
    // other axes makes the influence sphere jitter in and out of the orb while
    // the hand is held still.
    const out = new Float32Array(4)
    handToOrb(out, 0, 0.5, 0.5, 1, ORB_HAND_REACH)
    expect(Math.abs(out[2]!)).toBeLessThanOrEqual(1.5)
  })
})

test.describe('the displacement falloff', () => {
  // The shader computes exp(-d² · k) · strength. Mirrored here because the
  // property that matters is arithmetic, not GLSL: it must be finite at zero.
  const push = (d: number) => ORB_PUSH_STRENGTH * Math.exp(-d * d * ORB_PUSH_FALLOFF)

  test('is finite at zero distance', () => {
    // This is the whole reason the falloff is Gaussian. An inverse-square field
    // goes to infinity here, so a neuron sitting exactly where the hand is gets
    // flung out of the scene — once, unreproducibly, looking like a geometry bug.
    expect(Number.isFinite(push(0))).toBe(true)
    expect(push(0)).toBeCloseTo(ORB_PUSH_STRENGTH, 6)
  })

  test('decays monotonically and is negligible by one unit', () => {
    let previous = Infinity
    for (let d = 0; d <= 2; d += 0.1) {
      const value = push(d)
      expect(value).toBeLessThanOrEqual(previous)
      previous = value
    }
    expect(push(1)).toBeLessThan(ORB_PUSH_STRENGTH * 0.1)
  })

  test('never displaces a particle further than the shell radius', () => {
    // A displacement larger than the object tears it apart rather than parting it.
    expect(push(0)).toBeLessThan(2)
  })
})

test.describe('spread', () => {
  test('hands at rest separation neither open nor close the orb', () => {
    // The load-bearing number. Get it wrong and simply holding both hands up
    // opens the orb permanently, which reads as a stuck animation.
    expect(deriveSpread(HANDS_REST_SEPARATION)).toBeCloseTo(0, 6)
  })

  test('wider opens, closer closes, and both saturate', () => {
    expect(deriveSpread(HANDS_REST_SEPARATION + 0.2)).toBeGreaterThan(0)
    expect(deriveSpread(HANDS_REST_SEPARATION - 0.2)).toBeLessThan(0)
    expect(deriveSpread(2)).toBe(1)
    expect(deriveSpread(0)).toBe(-1)
  })

  test('one hand closes the orb rather than freezing it half-open', () => {
    resetOrbDrive()
    settle([hand({ x: 0.2 }), hand({ x: 0.8 })], 1)
    expect(orbDrive.spread).toBeGreaterThan(0.3)
    settle([hand({ x: 0.2 }), null], 1)
    expect(orbDrive.spread).toBeCloseTo(0, 1)
    resetOrbDrive()
  })
})

test.describe('aperture', () => {
  test('a relaxed hand is neutral', () => {
    // Openness and grab are not quite opposites — a relaxed hand scores low on
    // both — so the orb must sit still unless you are doing something
    // deliberate.
    expect(deriveAperture(0.1, 0.1)).toBeCloseTo(0, 6)
  })

  test('an open palm opens and a fist closes', () => {
    expect(deriveAperture(1, 0)).toBe(1)
    expect(deriveAperture(0, 1)).toBe(-1)
  })
})

test.describe('presence and spin', () => {
  test.afterEach(() => resetOrbDrive())

  test('presence fades in and out rather than popping', () => {
    // Tracking blinks. An influence sphere appearing and vanishing between
    // frames is far more noticeable than the influence itself.
    resetOrbDrive()
    driveOrbFromHands([hand(), null], 1 / 60)
    expect(orbDrive.hands[3]).toBeGreaterThan(0)
    expect(orbDrive.hands[3]).toBeLessThan(0.5)
    settle([hand(), null], 1)
    expect(orbDrive.hands[3]).toBeGreaterThan(0.9)
  })

  test('a hand leaving keeps its last position while it fades', () => {
    // Snapping the point to the origin first would drag the influence sphere
    // straight through the middle of the orb on the way out.
    resetOrbDrive()
    settle([hand({ x: 0.1 }), null], 1)
    const parked = orbDrive.hands[0]
    driveOrbFromHands([null, null], 1 / 60)
    expect(orbDrive.hands[0]).toBeCloseTo(parked!, 6)
    expect(orbDrive.hands[3]).toBeLessThan(1)
  })

  test('a flick imparts spin that coasts down', () => {
    resetOrbDrive()
    settle([hand({ vx: 1.5 }), null], 0.3)
    const spun = orbDrive.spin
    expect(Math.abs(spun)).toBeGreaterThan(0.05)
    settle([hand({ vx: 0 }), null], 3)
    expect(Math.abs(orbDrive.spin)).toBeLessThan(Math.abs(spun) * 0.2)
  })

  test('an absurd velocity cannot leave the orb spinning for seconds', () => {
    // One tracker glitch reporting a wild velocity would otherwise integrate
    // into momentum that takes ages to bleed off.
    resetOrbDrive()
    driveOrbFromHands([hand({ vx: 5000 }), null], 1 / 60)
    expect(Math.abs(orbDrive.spin)).toBeLessThanOrEqual(6)
  })

  test('reduced motion, expressed as no hands, leaves everything at rest', () => {
    resetOrbDrive()
    settle([hand({ x: 0.2, openness: 1 }), hand({ x: 0.9, openness: 1 })], 1)
    settle([null, null], 2)
    expect(orbDrive.spread).toBeCloseTo(0, 2)
    expect(orbDrive.aperture).toBeCloseTo(0, 2)
    for (let i = 0; i < MAX_HANDS; i++) expect(orbDrive.hands[i * 4 + 3]).toBeCloseTo(0, 2)
  })
})

test.describe('the motion vocabulary', () => {
  test('the rates are ordered from ambient to attached', () => {
    // The names have to mean something relative to each other, or naming them
    // has bought nothing over the twelve inline numbers they replaced.
    expect(GLIDE).toBeLessThan(DRIFT)
    expect(DRIFT).toBeLessThan(SETTLE)
    expect(SETTLE).toBeLessThan(EASE)
    expect(EASE).toBeLessThan(SNAP)
    expect(SNAP).toBeLessThan(INSTANT)
  })
})
