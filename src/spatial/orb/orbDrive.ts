/**
 * What the orb is currently doing, as numbers a shader can read.
 *
 * Mutated in place and sampled inside `useFrame`, for the same reason
 * `src/core/hands/handFrame.ts` exists: this changes at frame rate and at
 * gesture rate, and routing it through Zustand would re-render the React tree
 * every time a hand moved. Discrete state (which phase the brain is in) still
 * lives in the store; this is the continuous consequence of it.
 *
 * Never reassign the object or its arrays — the shader uniforms hold references
 * to them, and replacing one silently detaches the orb from its own state.
 */
import type { BrainPhase } from '@/core/store/useBrainStore'

/**
 * How many pulses can be in flight at once.
 *
 * Four is enough that a fast run of pinches overlaps convincingly, and small
 * enough to pass as a fixed-size uniform array — which is what keeps this to a
 * handful of floats per frame instead of a buffer upload. A fifth pulse
 * overwrites the oldest, so rapid input degrades by dropping history rather
 * than by queueing.
 */
export const MAX_PULSES = 4

/** Metres per second a pulse front travels through the network. */
export const PULSE_SPEED = 3.2

/** How long a pulse stays lit. Past this it is off, and the slot is reusable. */
export const PULSE_LIFE = 1.6

/** How many hands the orb tracks. Two, because there are two. */
export const MAX_HANDS = 2

export interface OrbDrive {
  /** Seconds since the scene started. The shaders' single clock. */
  time: number
  /** Ring buffer of pulse origins, xyz packed. Length MAX_PULSES * 3. */
  pulseOrigins: Float32Array
  /** `time` at which each pulse fired. Negative means the slot is empty. */
  pulseTimes: Float32Array
  /** 0..1 overall liveliness — drives brightness, spin rate and core surge. */
  energy: number
  /** 0..1 how much the core should be surging, independent of energy. */
  surge: number
  /** Accent colour as rgb 0..1, damped toward the phase's colour. */
  accent: Float32Array
  /** The phase the accent is heading toward. */
  phase: BrainPhase
  /** Next ring-buffer slot to overwrite. */
  cursor: number

  // ── The continuous channel: what your hands are doing, right now ──────────
  //
  // Discrete events (a pinch, a wake) fire pulses. These are the other half:
  // values that change every frame while a hand is up, so the orb responds to
  // being approached rather than only to being tapped. All of them are shader
  // uniforms, so the whole channel costs about ten floats a frame and no CPU
  // work in any layer.

  /**
   * Per hand: xyz in ORB space, then presence 0..1.
   *
   * Orb space, not world space — the hand's tracking plane sits five units in
   * front of the orb and would never intersect it. `handToOrb` maps the frame
   * onto the orb's own extent instead, so sweeping a hand across the camera
   * sweeps it through the object.
   *
   * Presence is damped rather than boolean: tracking blinks, and a hand's
   * influence popping in and out is far more noticeable than the influence
   * itself.
   */
  hands: Float32Array

  /**
   * Two-handed spread: -1 hands together, 0 at rest, +1 hands wide apart.
   *
   * Zero whenever fewer than two hands are visible, so putting one hand down
   * closes the orb rather than freezing it half-open.
   */
  spread: number

  /** Aperture: -1 a closed fist, 0 neutral, +1 an open palm. */
  aperture: number

  /** Spin imparted by hand motion, decaying toward zero. Radians per second. */
  spin: number
}

export const orbDrive: OrbDrive = {
  time: 0,
  pulseOrigins: new Float32Array(MAX_PULSES * 3),
  pulseTimes: new Float32Array(MAX_PULSES).fill(-1000),
  energy: 0.25,
  surge: 0,
  accent: new Float32Array([0.84, 0.9, 1]),
  phase: 'idle',
  cursor: 0,
  hands: new Float32Array(MAX_HANDS * 4),
  spread: 0,
  aperture: 0,
  spin: 0,
}

/** Sends a shockwave out through the network from a point in orb space. */
export function firePulse(x: number, y: number, z: number): void {
  const i = orbDrive.cursor
  orbDrive.pulseOrigins[i * 3] = x
  orbDrive.pulseOrigins[i * 3 + 1] = y
  orbDrive.pulseOrigins[i * 3 + 2] = z
  orbDrive.pulseTimes[i] = orbDrive.time
  orbDrive.cursor = (i + 1) % MAX_PULSES
}

const fract = (v: number): number => v - Math.floor(v)

/**
 * A pulse from a point on the shell chosen by a hash of the clock.
 *
 * For events that have no position of their own — a thought starting, a socket
 * connecting. Hashed rather than `Math.random()` so the same moment always
 * produces the same point, which is what lets a test assert it.
 */
export function firePulseAt(radius: number, seed = orbDrive.time): void {
  const cosPhi = fract(Math.sin(seed * 12.9898) * 43758.5453) * 2 - 1
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi))
  const theta = fract(Math.sin(seed * 78.233) * 24634.6345) * Math.PI * 2
  firePulse(radius * sinPhi * Math.cos(theta), radius * cosPhi, radius * sinPhi * Math.sin(theta))
}

/**
 * Where each phase sits, as [r, g, b, energy].
 *
 * Colours are drawn from `palette.ts` rather than the reference orb's amber,
 * so the orb belongs to the same interface as everything around it. All four
 * stay at or below 1.0 deliberately: ACES tone mapping pushes values above one
 * toward warm as it rolls them off, which is how an earlier attempt at an HDR
 * light source in this scene came out gold. Brightness above white is bought
 * with bloom, not with the colour.
 */
export const PHASE_DRIVE: Record<BrainPhase, readonly [number, number, number, number]> = {
  idle: [0.84, 0.9, 1.0, 0.22],
  listening: [0.49, 0.61, 1.0, 0.55],
  thinking: [0.94, 0.71, 0.16, 0.8],
  speaking: [0.29, 0.87, 0.6, 1.0],
  error: [1.0, 0.35, 0.32, 0.6],
}

/** Clears everything in flight. For unmount and for the test suite. */
export function resetOrbDrive(): void {
  orbDrive.time = 0
  orbDrive.pulseTimes.fill(-1000)
  orbDrive.pulseOrigins.fill(0)
  orbDrive.cursor = 0
  orbDrive.energy = 0.25
  orbDrive.surge = 0
  orbDrive.phase = 'idle'
  orbDrive.accent.set(PHASE_DRIVE.idle.slice(0, 3))
  orbDrive.hands.fill(0)
  orbDrive.spread = 0
  orbDrive.aperture = 0
  orbDrive.spin = 0
}

/**
 * Normalised tracking space → the orb's own space.
 *
 * The hand cursor is placed on a plane 6.5 units in front of the camera, which
 * is about five units in front of the orb — so in world terms a hand never
 * comes near it and a proximity field would never fire. This maps the frame
 * onto the orb's extent instead: the centre of the camera image is the centre
 * of the orb, and the edges reach a little past the shell so a hand can be seen
 * to approach from outside before it starts pushing.
 *
 * X is mirrored and Y inverted for the same reasons `hands/projection.ts` does
 * it — the feed is shown mirrored, and video counts down while the world counts
 * up. Depth comes from MediaPipe's relative z, which is noisy in absolute terms
 * but perfectly good for "reaching in and out".
 */
export function handToOrb(
  out: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number,
  reach: number,
): void {
  out[offset] = (0.5 - x) * 2 * reach
  out[offset + 1] = (0.5 - y) * 2 * reach
  // Scaled well below x and y: MediaPipe's z is a rough wrist-relative offset,
  // and trusting it as far as the other two axes makes the influence sphere
  // jitter in and out of the orb while the hand is still.
  out[offset + 2] = Math.max(-1.5, Math.min(1.5, z * 4))
}
