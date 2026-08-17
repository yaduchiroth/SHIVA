import { getHand } from '@/core/hands/handFrame'
import { emit } from '@/core/events/bus'
import { clamp } from '@/lib/math'

/**
 * Two-handed gestures.
 *
 * Every gesture until now has been single-handed, which quietly wasted the fact
 * that the tracker follows two hands and always has. The organising idea here is
 * a distinction people already have in their bodies:
 *
 *   **one hand grabs an object — two hands grab the world.**
 *
 * So a single pinch still picks up a panel, unchanged, while pinching with both
 * hands takes hold of the space itself: move them together to turn the carousel
 * continuously, spread them apart or bring them together to pull the camera in
 * and out. Nothing had to be given up to add it, because the two-handed channel
 * was entirely empty.
 *
 * It also closes a real asymmetry. The pointer has always had smooth 1:1 drag
 * rotation while hands only had the swipe — a discrete one-panel step. Turning
 * the ring slowly, or stopping halfway between two panels to compare them, was
 * simply not expressible with hands. Now it is.
 *
 * Credit where it is due: the pinch-count-selects-mode idea, and the detail of
 * resetting reference points on every mode change, come from Sagar Tamang's
 * ULTRON orb UI (MIT). Its pinch thresholds turned out to be 0.32/0.45 — the
 * same numbers SHIVA's calibration arrived at independently, which is the most
 * reassuring thing about them.
 */

/**
 * Normalised movement below this is treated as stillness.
 *
 * Two hands held deliberately still still drift by a fraction of a percent, and
 * without a floor that drift becomes a slow unbidden rotation — the interface
 * turning on its own while you hold a pose, which reads as broken rather than
 * sensitive.
 */
const DEAD_ZONE = 0.0015

/**
 * Panels turned per unit of normalised hand travel.
 *
 * Chosen to match the pointer: sweeping hands across half the frame turns the
 * ring about two panels, which is roughly what dragging half the window does.
 * The two input paths should feel like the same gesture, not two different ones.
 */
const SPIN_GAIN = 4

/**
 * Per-frame zoom clamp.
 *
 * The zoom factor is a RATIO of successive hand separations, so a single frame
 * where the tracker briefly misplaces one hand produces an enormous ratio and a
 * camera that teleports. Clamping per frame costs nothing at human speeds — you
 * cannot spread your hands 18% in a sixtieth of a second — and turns a violent
 * glitch into an imperceptible one.
 */
const ZOOM_MIN = 0.85
const ZOOM_MAX = 1.18

/**
 * Hands must be at least this far apart to read a zoom.
 *
 * Two hands nearly touching give a tiny separation, and the ratio of two tiny
 * numbers is noise amplified — the camera would lurch whenever you brought your
 * hands together.
 */
const MIN_SEPARATION = 0.08

/**
 * Tracks the two-handed pose across frames.
 *
 * Deliberately not a React hook and deliberately not in the store: it is stepped
 * once per tracking frame from the same loop that runs the per-hand recognizers,
 * for the same reason they aren't in the store either. It emits discrete events;
 * that is where React finds out.
 */
export class BimanualRecognizer {
  private active = false
  private lastMidX: number | null = null
  private lastSeparation: number | null = null

  /** Whether both hands currently hold the world. Read by the input policy. */
  get engaged(): boolean {
    return this.active
  }

  /**
   * Steps one frame. Call after both per-hand recognizers have updated, so the
   * gestures being read are from this frame rather than the last one.
   */
  update(): void {
    const left = getHand('left')
    const right = getHand('right')

    const both =
      left.visible && right.visible && left.gesture === 'pinch' && right.gesture === 'pinch'

    if (both !== this.active) {
      this.active = both
      // Reference points are cleared on EVERY transition, not just on release.
      // Keeping a stale midpoint across a re-grab makes the world jump by
      // however far your hands moved while not pinching — which, since you
      // usually reposition between grabs, is most of the frame.
      this.lastMidX = null
      this.lastSeparation = null
      emit(both ? 'world:grab' : 'world:release', {})
      if (both) emit('ui:confirm', { intensity: 0.6 })
      return
    }

    if (!this.active) return

    // x is mirrored so that moving both hands right turns the ring the way a
    // physical object would. Same convention as everywhere else in the tracker.
    const midX = 1 - (left.position.x + right.position.x) / 2
    const separation = Math.hypot(
      left.position.x - right.position.x,
      left.position.y - right.position.y,
    )

    if (this.lastMidX !== null) {
      const delta = midX - this.lastMidX
      if (Math.abs(delta) > DEAD_ZONE) {
        emit('world:spin', { delta: delta * SPIN_GAIN })
      }
    }

    if (
      this.lastSeparation !== null &&
      separation > MIN_SEPARATION &&
      this.lastSeparation > MIN_SEPARATION
    ) {
      // Hands apart → separation grows → factor below 1 → camera comes closer.
      const factor = clamp(this.lastSeparation / separation, ZOOM_MIN, ZOOM_MAX)
      emit('world:zoom', { factor })
    }

    this.lastMidX = midX
    this.lastSeparation = separation
  }

  /**
   * Clears state when tracking stops or a hand leaves the frame.
   *
   * Emits the release for the same reason `HandRecognizer.reset` does: a hand
   * that vanishes mid-gesture must not leave the world held, or the interface
   * keeps interpreting stray movement as a drag with no way to let go.
   */
  reset(): void {
    if (this.active) emit('world:release', {})
    this.active = false
    this.lastMidX = null
    this.lastSeparation = null
  }
}
