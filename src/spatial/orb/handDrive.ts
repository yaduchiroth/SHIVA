import { damp } from '@/lib/math'
import {
  EASE,
  HANDS_REST_SEPARATION,
  HANDS_SEPARATION_RANGE,
  ORB_HAND_REACH,
  ORB_SPIN_DECAY,
  ORB_SPIN_GAIN,
} from '@/core/config/motion'
import { handToOrb, orbDrive } from './orbDrive'

/**
 * Turns what the hands are doing into what the orb should do.
 *
 * Split out of the component because it is the part with judgement in it —
 * where "at rest" is, how a fist differs from an open palm, whether putting a
 * hand down should freeze the orb or close it — and none of that is testable
 * inside a `useFrame` closure.
 *
 * Everything it writes is damped. The tracker blinks, MediaPipe's openness
 * estimate is noisy near the thresholds, and a hand held still is never quite
 * still: driving the orb from raw values makes it twitch, which reads as the
 * tracking being broken rather than the orb being alive.
 */

export interface HandSample {
  visible: boolean
  /** Normalised tracking space, origin top-left. */
  x: number
  y: number
  z: number
  /** 0 fully closed, 1 fully open. */
  openness: number
  /** 0 open, 1 closed fist. */
  grab: number
  /** Normalised screen-space velocity, units per second. */
  vx: number
}

/** Left hand first, right hand second, so a hand never swaps influence slots. */
export type HandPair = readonly [HandSample | null, HandSample | null]

/**
 * Separation, mapped to -1 (together) … 0 (rest) … +1 (wide).
 *
 * Exported for the test, because the rest point is the whole design: get it
 * wrong and simply holding both hands up opens the orb permanently, which
 * looks like a stuck animation rather than a response.
 */
export function deriveSpread(separation: number): number {
  const delta = separation - HANDS_REST_SEPARATION
  // Asymmetric on purpose. Opening has as much room as you care to give it, but
  // closing bottoms out at zero separation — hands touching. Normalising both
  // sides by the same range meant hands pressed together only reached -0.91, so
  // the most emphatic closing gesture a person can make never fully closed the
  // orb, and the last stretch of the range was simply unreachable.
  const t = delta >= 0 ? delta / HANDS_SEPARATION_RANGE : delta / HANDS_REST_SEPARATION
  return Math.max(-1, Math.min(1, t))
}

/**
 * Aperture, from openness and grab, as one signed value.
 *
 * The recognizer reports these separately and they are not quite opposites — a
 * relaxed hand scores low on both. Subtracting gives a single axis where the
 * relaxed hand sits at zero, which is what the orb wants: neutral unless you
 * are doing something deliberate.
 */
export const deriveAperture = (openness: number, grab: number): number =>
  Math.max(-1, Math.min(1, openness - grab))

export function driveOrbFromHands(hands: HandPair, dt: number): void {
  const step = dt
  let visibleCount = 0
  let apertureTarget = 0
  let velocity = 0

  for (let i = 0; i < hands.length; i++) {
    const hand = hands[i]
    const slot = i * 4
    if (hand?.visible) {
      visibleCount++
      handToOrb(orbDrive.hands, slot, hand.x, hand.y, hand.z, ORB_HAND_REACH)
      apertureTarget += deriveAperture(hand.openness, hand.grab)
      velocity += hand.vx
      orbDrive.hands[slot + 3] = damp(orbDrive.hands[slot + 3]!, 1, EASE, step)
    } else {
      // Position is left where it was rather than zeroed. Fading presence out
      // from the last known point looks like a hand withdrawing; snapping the
      // point to the origin first drags the influence sphere through the middle
      // of the orb on the way out.
      orbDrive.hands[slot + 3] = damp(orbDrive.hands[slot + 3]!, 0, EASE, step)
    }
  }

  // Spread needs both hands. With one, the target is zero, so putting a hand
  // down closes the orb rather than leaving it frozen half-open.
  let spreadTarget = 0
  const [left, right] = hands
  if (left?.visible && right?.visible) {
    spreadTarget = deriveSpread(Math.hypot(left.x - right.x, left.y - right.y))
  }
  orbDrive.spread = damp(orbDrive.spread, spreadTarget, EASE, step)

  orbDrive.aperture = damp(
    orbDrive.aperture,
    visibleCount > 0 ? apertureTarget / visibleCount : 0,
    EASE,
    step,
  )

  // Momentum, not position: sustained movement spins the orb up and stopping
  // lets it coast down, which is what a flick should feel like. Mirrored,
  // because the camera feed is.
  orbDrive.spin += -velocity * ORB_SPIN_GAIN * step
  orbDrive.spin *= Math.exp(-ORB_SPIN_DECAY * step)
  // Belt and braces on the integration: a tracker glitch reporting an absurd
  // velocity for one frame would otherwise leave the orb spinning for seconds.
  orbDrive.spin = Math.max(-6, Math.min(6, orbDrive.spin))

  // Energy is deliberately NOT written here. The brain's phase owns it, and two
  // writers damping the same value toward different targets on the same frame
  // is a fight neither wins — it settles somewhere between and neither cause is
  // legible. Hand presence has the whole displacement channel to express itself
  // through already.
}
