/** Shared vocabulary for the spatial layer. */

export type Handedness = 'left' | 'right'

export type GestureName = 'pinch' | 'grab' | 'palm' | 'point' | 'idle'

export type TrackingStatus =
  | 'idle' // never asked for the camera
  | 'requesting' // permission prompt is up
  | 'loading' // model + WASM warming
  | 'active' // landmarker running
  | 'denied' // user said no
  | 'unavailable' // no camera, insecure context, or assets missing

/** How the user is currently driving the OS. */
export type InputMode = 'hand' | 'pointer'

export type BootPhase = 'cold' | 'booting' | 'ready'

export type ModuleId = 'system' | 'weather' | 'calendar' | 'projects' | 'markets' | 'social'

export interface ModuleDescriptor {
  id: ModuleId
  /** Displayed on the panel face. */
  label: string
  /** Four-character glyph in the panel corner — FUI density cue. */
  code: string
  /** One line of subtext. */
  summary: string
  /** Accent used for this module's readouts, as a CSS colour token value. */
  accent: string
  /** Phase in which this module gets real data. Phase 1 panels are structural. */
  liveIn: 1 | 2 | 3
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** A single tracked hand, in normalised video space (0..1, origin top-left). */
export interface HandState {
  visible: boolean
  handedness: Handedness
  /** Filtered palm centre. */
  position: Vec3
  /** Filtered index fingertip — the pointing ray origin. */
  tip: Vec3
  /** 0 = fully open, 1 = fully closed. */
  pinch: number
  grab: number
  /** Palm-forward confidence, 0..1. */
  openness: number
  gesture: GestureName
  /** Normalised screen-space velocity, units/sec. */
  velocity: Vec3
  /** Wall-clock seconds of the frame this state came from. */
  timestamp: number
  /**
   * The raw 21 landmarks, unfiltered, in normalised video space.
   *
   * Kept alongside the derived values purely so the debug overlay can draw the
   * skeleton. Mutated in place like everything else on this object — never
   * reassigned, or the overlay's reference goes stale.
   */
  landmarks: Vec3[]
}
