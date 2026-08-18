/**
 * How fast things settle.
 *
 * Every animated value in SHIVA converges with `damp()` from `lib/math`, and
 * until now each call site picked its own rate inline — twelve distinct numbers
 * between 1.2 and 22, most of them arrived at by nudging one component until it
 * felt right in isolation. The result is that unrelated things settle at
 * unrelated speeds for no reason anyone could state, which is most of what
 * makes an interface feel assembled rather than designed.
 *
 * These are the rates, named by what they are for. Six is few enough to hold in
 * your head and enough to cover the range from "attached to your hand" to
 * "ambient drift you never consciously notice".
 *
 * The unit is a rate, not a duration: `damp(current, target, RATE, dt)` is
 * frame-rate independent, so a value converges the same on a 60 Hz display and
 * a 120 Hz one. Higher is snappier. Roughly, a value covers 95% of its distance
 * in `3 / RATE` seconds.
 */

/** Cursors and anything that must feel physically attached to the hand. ~140 ms. */
export const INSTANT = 22

/** A discrete response to a deliberate action — a press, a step. ~215 ms. */
export const SNAP = 14

/** Focus, colour, opacity. Fast enough to feel immediate, slow enough to read. ~375 ms. */
export const EASE = 8

/** Positions and layout moving to a new arrangement. ~600 ms. */
export const SETTLE = 5

/** Mood: energy, surge decay, anything that should lag behind its cause. ~1.2 s. */
export const DRIFT = 2.6

/** Ambient camera drift and idle motion — felt, not watched. ~2.5 s. */
export const GLIDE = 1.2

/**
 * The largest frame delta any damping is allowed to see.
 *
 * A backgrounded tab resumes with one enormous delta, and `damp` over it snaps
 * every value straight to its target — which on return looks like the whole
 * interface glitching at once. Clamping costs nothing at real frame rates: 50 ms
 * is already a 20 fps frame.
 */
export const MAX_STEP = 0.05

// ── The orb's response to hands ──────────────────────────────────────────────

/**
 * How far a hand pushes the orb's particles aside, in world units, at its centre.
 *
 * The shell is radius 2.0, so half a unit is plainly visible without tearing
 * the object apart.
 */
export const ORB_PUSH_STRENGTH = 0.55

/**
 * Gaussian falloff coefficient: influence is `exp(-d² · k)`.
 *
 * Gaussian rather than inverse-square, and that is not a stylistic choice. An
 * inverse-square field goes to infinity at zero distance, so a neuron that
 * happens to sit exactly where your hand is would be flung to the horizon —
 * one particle, once, unreproducibly. A Gaussian peaks at a finite value and
 * dies smoothly.
 *
 * At k = 3, influence is half at 0.48 units and a tenth at 0.88 — an influence
 * sphere about the size of a hand, which is the point.
 */
export const ORB_PUSH_FALLOFF = 3

/** How far the hand's influence sphere can reach into the orb, in world units. */
export const ORB_HAND_REACH = 2.6

/** How much a two-handed spread separates the orb's layers. */
export const ORB_SPREAD_GAIN = 0.85

/** How much an open palm expands the shell, and a fist contracts it. */
export const ORB_APERTURE_GAIN = 0.22

/** How much hand motion feeds the shell's spin. */
export const ORB_SPIN_GAIN = 2.4

/** How fast imparted spin bleeds off once the hand stops. Per second. */
export const ORB_SPIN_DECAY = 1.1

/**
 * Hand separation, in normalised tracking space, that counts as neutral.
 *
 * Below it the orb closes, above it the orb opens. Measured from hands held
 * comfortably in front of a laptop camera — close enough together to be
 * relaxed, far enough apart that neither is at the frame edge.
 */
export const HANDS_REST_SEPARATION = 0.32

/** How much further apart than rest counts as fully open. */
export const HANDS_SEPARATION_RANGE = 0.35
