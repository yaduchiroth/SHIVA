import type { Handedness, HandState, Vec3 } from '@/core/types'
import type { GestureName } from '@/core/types'
import { OneEuroVec3, OneEuroFilter } from '@/lib/one-euro'
import { Schmitt, clamp } from '@/lib/math'
import { emit } from '@/core/events/bus'

/**
 * Turns 21 landmarks into gestures.
 *
 * Three things make this reliable rather than a demo that works once:
 *
 *   1. **Scale normalisation.** Every distance is divided by the hand's own
 *      size (wrist→middle-knuckle). A raw pinch threshold in normalised video
 *      units only works at one distance from the camera; divide it out and the
 *      same gesture registers whether the hand is near or far.
 *   2. **Hysteresis.** Gestures enter and exit on different thresholds, so a
 *      signal hovering at the boundary can't strobe on and off.
 *   3. **Filtering before thresholding.** Positions are One Euro filtered
 *      first, so jitter can't trip a threshold on a single bad frame.
 */

// MediaPipe hand landmark indices.
const WRIST = 0
const THUMB_TIP = 4
const INDEX_MCP = 5
const INDEX_TIP = 8
const MIDDLE_MCP = 9
const MIDDLE_TIP = 12
const RING_TIP = 16
const PINKY_MCP = 17
const PINKY_TIP = 20

export interface Landmark {
  x: number
  y: number
  z: number
}

const dist = (a: Landmark, b: Landmark): number =>
  Math.hypot(a.x - b.x, a.y - b.y, (a.z - b.z) * 0.5)

/** Per-hand filter + gate state. Kept out of the store; see handFrame.ts. */
export class HandRecognizer {
  private readonly palmFilter = new OneEuroVec3({ minCutoff: 1.0, beta: 0.02 })
  private readonly tipFilter = new OneEuroVec3({ minCutoff: 1.6, beta: 0.03 })
  // Pinch needs a faster cutoff than position: it's a deliberate, quick action
  // and over-smoothing it makes selection feel unresponsive.
  private readonly pinchFilter = new OneEuroFilter({ minCutoff: 2.4, beta: 0.01 })
  private readonly grabFilter = new OneEuroFilter({ minCutoff: 2.0, beta: 0.01 })

  // Every threshold below is measured, not guessed — see tests/calibrate.spec.ts,
  // which prints these ratios for a set of anatomically-proportioned poses.
  //
  // Pinch and grab trigger when their value falls BELOW the enter threshold, so
  // enter < exit for those (see Schmitt). Open palm triggers on the way up.

  // Thumb-to-index distance over palm scale. Pinching measures ~0.03; the
  // nearest non-pinch pose is a point at ~1.30, so this is a wide margin.
  private readonly pinchGate = new Schmitt(0.32, 0.45)

  // Grab keys off the FURTHEST extended fingertip, not the mean. The mean can't
  // separate a fist (0.88) from a point (1.20) — one extended finger barely
  // moves an average of four. The maximum separates them completely: a fist's
  // furthest fingertip is at 0.88, a point's is at 2.15.
  private readonly grabGate = new Schmitt(1.1, 1.35)

  // Openness is normalised against a fully-splayed hand. The margin that matters
  // is against a *relaxed* hand — fingers loosely curled, the default resting
  // pose — which measures 0.69 against an open palm's 0.96. Treating that as an
  // open palm made resting hands arm accidental swipes.
  private readonly palmGate = new Schmitt(0.9, 0.8)

  private lastPosition: Vec3 = { x: 0, y: 0, z: 0 }
  private lastTimestamp = 0
  private swipeCooldown = 0
  private activeGesture: GestureName = 'idle'

  constructor(private readonly handedness: Handedness) {}

  reset(): void {
    this.palmFilter.reset()
    this.tipFilter.reset()
    this.pinchFilter.reset()
    this.grabFilter.reset()
    this.pinchGate.reset()
    this.grabGate.reset()
    this.palmGate.reset()
    this.activeGesture = 'idle'
    this.lastTimestamp = 0
  }

  /**
   * @param landmarks 21 landmarks in normalised video space
   * @param timestamp seconds
   * @param out the HandState to mutate in place
   */
  update(landmarks: readonly Landmark[], timestamp: number, out: HandState): void {
    const wrist = landmarks[WRIST]
    const middleMcp = landmarks[MIDDLE_MCP]
    const indexMcp = landmarks[INDEX_MCP]
    const pinkyMcp = landmarks[PINKY_MCP]
    const thumbTip = landmarks[THUMB_TIP]
    const indexTip = landmarks[INDEX_TIP]
    const middleTip = landmarks[MIDDLE_TIP]
    const ringTip = landmarks[RING_TIP]
    const pinkyTip = landmarks[PINKY_TIP]

    if (
      !wrist ||
      !middleMcp ||
      !indexMcp ||
      !pinkyMcp ||
      !thumbTip ||
      !indexTip ||
      !middleTip ||
      !ringTip ||
      !pinkyTip
    ) {
      return
    }

    // Hand scale: the reference length everything else is measured against.
    // Guarded because a near-degenerate hand (edge of frame, mid-occlusion)
    // would otherwise divide by ~0 and produce enormous ratios.
    const scale = Math.max(dist(wrist, middleMcp), 0.02)

    // ── Palm centre ──────────────────────────────────────────────────────────
    // Centroid of wrist and the knuckle row is far steadier than the wrist
    // alone, which swings widely as the hand rotates.
    const px = (wrist.x + indexMcp.x + pinkyMcp.x + middleMcp.x) / 4
    const py = (wrist.y + indexMcp.y + pinkyMcp.y + middleMcp.y) / 4
    const pz = (wrist.z + indexMcp.z + pinkyMcp.z + middleMcp.z) / 4

    this.palmFilter.filter(out.position, px, py, pz, timestamp)
    this.tipFilter.filter(out.tip, indexTip.x, indexTip.y, indexTip.z, timestamp)

    // ── Velocity ─────────────────────────────────────────────────────────────
    const dt = this.lastTimestamp === 0 ? 0 : timestamp - this.lastTimestamp
    if (dt > 0.0001) {
      out.velocity.x = (out.position.x - this.lastPosition.x) / dt
      out.velocity.y = (out.position.y - this.lastPosition.y) / dt
      out.velocity.z = (out.position.z - this.lastPosition.z) / dt
    }
    this.lastPosition.x = out.position.x
    this.lastPosition.y = out.position.y
    this.lastPosition.z = out.position.z
    this.lastTimestamp = timestamp

    // ── Pinch ────────────────────────────────────────────────────────────────
    const pinchRatio = this.pinchFilter.filter(dist(thumbTip, indexTip) / scale, timestamp)
    const pinching = this.pinchGate.update(pinchRatio)
    // Reported as 0..1 closedness, which is more useful downstream than a raw
    // distance — it can drive a cursor's visual state continuously.
    out.pinch = clamp(1 - pinchRatio / 0.6, 0, 1)

    // ── Finger extension ─────────────────────────────────────────────────────
    // Each fingertip's distance from the wrist, over palm scale. Everything
    // below is derived from these, so the whole classifier is scale-invariant:
    // the same gesture reads identically near the camera or far from it.
    const extension = [
      dist(indexTip, wrist) / scale,
      dist(middleTip, wrist) / scale,
      dist(ringTip, wrist) / scale,
      dist(pinkyTip, wrist) / scale,
    ]
    const meanExtension = (extension[0]! + extension[1]! + extension[2]! + extension[3]!) / 4
    const maxExtension = Math.max(extension[0]!, extension[1]!, extension[2]!, extension[3]!)

    // ── Grab ─────────────────────────────────────────────────────────────────
    // Gated on the furthest fingertip: a fist requires that EVERY finger is in,
    // and one straight finger is enough to disqualify it. Using the mean here
    // let a pointing hand drift into grab territory.
    const grabRatio = this.grabFilter.filter(maxExtension, timestamp)
    const grabbing = this.grabGate.update(grabRatio)
    // Reported as 0..1 closedness so a cursor can respond continuously, before
    // the gate trips.
    out.grab = clamp(1 - (grabRatio - 0.88) / 1.3, 0, 1)

    // ── Open palm ────────────────────────────────────────────────────────────
    // Normalised against a fully-splayed hand (~2.2 palm scales).
    const openness = clamp(meanExtension / 2.2, 0, 1)
    const palmOpen = this.palmGate.update(openness)
    out.openness = openness

    // ── Point ────────────────────────────────────────────────────────────────
    // Index extended while the other three are curled. Both halves are needed:
    // an open palm also has an extended index, and a fist also has the other
    // three curled.
    const indexExtended = extension[0]! > 1.6
    const othersCurled = (extension[1]! + extension[2]! + extension[3]!) / 3 < 1.35
    const pointing = indexExtended && othersCurled && !pinching

    // ── Resolve to one gesture ───────────────────────────────────────────────
    // Priority matters: a pinch is a subset of many hand shapes, so it must be
    // tested before the looser poses or it never wins.
    const gesture: GestureName = pinching
      ? 'pinch'
      : grabbing
        ? 'grab'
        : pointing
          ? 'point'
          : palmOpen
            ? 'palm'
            : 'idle'

    if (gesture !== this.activeGesture) {
      if (this.activeGesture !== 'idle') {
        emit('gesture:end', {
          hand: this.handedness,
          gesture: this.activeGesture,
          position: { ...out.position },
        })
      }
      if (gesture !== 'idle') {
        emit('gesture:start', {
          hand: this.handedness,
          gesture,
          position: { ...out.position },
        })
      }
      this.activeGesture = gesture
    }
    out.gesture = gesture

    // ── Swipe ────────────────────────────────────────────────────────────────
    // An open hand crossing quickly on the horizontal. Requiring an open palm
    // is what stops a fast grab-and-move from also registering as a swipe.
    if (this.swipeCooldown > 0) this.swipeCooldown -= dt

    const horizontal = Math.abs(out.velocity.x)
    if (
      this.swipeCooldown <= 0 &&
      palmOpen &&
      !pinching &&
      !grabbing &&
      horizontal > 0.9 &&
      horizontal > Math.abs(out.velocity.y) * 1.8
    ) {
      // x is mirrored on screen, so a hand moving right in tracking space
      // travels left visually — negate to give callers screen-space direction.
      emit('gesture:swipe', {
        hand: this.handedness,
        direction: out.velocity.x > 0 ? -1 : 1,
        speed: horizontal,
      })
      this.swipeCooldown = 0.55
    }

    // Mirror the raw landmarks for the debug overlay. Copied field-by-field
    // rather than reassigned so the overlay's array reference stays valid.
    for (let i = 0; i < 21 && i < landmarks.length; i++) {
      const source = landmarks[i]
      const target = out.landmarks[i]
      if (!source || !target) continue
      target.x = source.x
      target.y = source.y
      target.z = source.z
    }

    out.visible = true
    out.timestamp = timestamp
  }
}
