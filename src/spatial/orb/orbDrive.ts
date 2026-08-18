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
}
