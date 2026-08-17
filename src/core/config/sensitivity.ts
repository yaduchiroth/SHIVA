/**
 * How eagerly gestures fire.
 *
 * This exists because the first calibration was measured against synthetic
 * hands and then trusted, and the margins turned out to be far too narrow for
 * real ones. The numbers are worth writing down, because they explain the whole
 * file:
 *
 *   pose        fingertip→wrist, in palm widths
 *   fist        0.88
 *   relaxed     1.51 – 1.58
 *   open palm   2.08 – 2.15
 *
 * The original dead zone was 1.35 → 1.70. A hand hanging at rest sits at about
 * 1.54 — almost exactly in the middle, with roughly a tenth of a palm width of
 * clearance on either side. Every real hand that curls a little more than the
 * model's, or straightens a little less, spends its resting life brushing a
 * threshold. That reads as an interface reacting to things you did not do.
 *
 * Widening the band to 1.15 → 1.85 roughly doubles it, and it costs almost
 * nothing at the other end: a deliberate fist still clears the lower edge by
 * 0.27 and a deliberate open palm clears the upper edge by 0.23. Deliberate
 * poses were never near the boundary. Only resting ones were.
 *
 * The profiles below exist because none of this is universal — hand shape,
 * camera distance and how emphatically someone gestures all move these numbers,
 * and no single set is right for everyone. `?sensitivity=low|normal|high` picks
 * one at runtime so tuning is a page reload rather than an edit and a rebuild.
 */

export type SensitivityName = 'low' | 'normal' | 'high'

export interface SensitivityProfile {
  /** Fingertip→wrist, in palm widths, above which a finger counts as straight. */
  extended: number
  /** …and below which it counts as folded. The span between is the dead zone. */
  curled: number
  /** Normalised units/sec of horizontal travel that constitutes a swipe. */
  swipeSpeed: number
  /** Seconds before another swipe may fire. */
  swipeCooldown: number
  /** Panels turned per unit of two-handed travel. */
  spinGain: number
  /** Two-handed movement below this is treated as stillness. */
  spinDeadZone: number
}

export const SENSITIVITY: Record<SensitivityName, SensitivityProfile> = {
  /**
   * Calm. For hands that rest half-curled, or a camera close enough that small
   * movements cover a lot of normalised space.
   */
  low: {
    extended: 1.95,
    curled: 1.05,
    swipeSpeed: 2.0,
    swipeCooldown: 0.9,
    spinGain: 1.5,
    spinDeadZone: 0.006,
  },

  /**
   * The measured default. Dead zone centred on the gap between a resting hand
   * and a deliberate one, rather than on a resting hand itself.
   */
  normal: {
    extended: 1.85,
    curled: 1.15,
    // A hand crossing the frame deliberately moves at roughly 2 units/sec;
    // casual repositioning sits near 1. The old 0.9 was below casual, which is
    // why the carousel stepped while you were only moving your hand.
    swipeSpeed: 1.5,
    swipeCooldown: 0.75,
    spinGain: 2.2,
    spinDeadZone: 0.004,
  },

  /**
   * The original tuning. Quick, and prone to firing on a resting hand — kept so
   * the difference can be felt directly rather than argued about.
   */
  high: {
    extended: 1.7,
    curled: 1.35,
    swipeSpeed: 0.9,
    swipeCooldown: 0.55,
    spinGain: 4,
    spinDeadZone: 0.0015,
  },
}

let active: SensitivityProfile = SENSITIVITY.normal
let activeName: SensitivityName = 'normal'

/**
 * The profile in force.
 *
 * Read per frame rather than captured at construction, so switching takes
 * effect without rebuilding the recognizers — and so tests can set a profile
 * and have it apply to an instance they already made.
 */
export const getSensitivity = (): SensitivityProfile => active

export const getSensitivityName = (): SensitivityName => activeName

export function setSensitivity(name: SensitivityName): void {
  activeName = name
  active = SENSITIVITY[name]
}

/**
 * Applies `?sensitivity=` if present.
 *
 * Called when tracking starts rather than at module scope, because this module
 * is imported by the recognizer, which is imported by tests that have no
 * `window`.
 */
export function resolveSensitivityFromUrl(): SensitivityName {
  if (typeof window === 'undefined') return activeName
  const value = new URLSearchParams(window.location.search).get('sensitivity')
  if (value === 'low' || value === 'normal' || value === 'high') setSensitivity(value)
  return activeName
}
