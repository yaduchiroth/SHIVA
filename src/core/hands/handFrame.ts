import type { HandState, Handedness, Vec3 } from '@/core/types'

/**
 * The high-frequency half of hand state.
 *
 * This deliberately lives OUTSIDE React and outside Zustand. Hand tracking
 * produces a new pose 30–60 times a second; routing that through a store with
 * subscribers would re-render the React tree at tracking rate and destroy the
 * frame budget we're trying to protect.
 *
 * Instead: the tracking loop mutates this singleton in place, and consumers read
 * it inside `useFrame` — the render loop already runs every frame, so sampling
 * it there is free. Discrete, low-frequency state (did a pinch *start*? is the
 * camera active?) goes to Zustand, where re-rendering is the point.
 *
 * Rule of thumb: continuous values here, events and status in the store.
 */

const emptyVec = (): Vec3 => ({ x: 0, y: 0, z: 0 })

const emptyHand = (handedness: Handedness): HandState => ({
  visible: false,
  handedness,
  position: emptyVec(),
  tip: emptyVec(),
  pinch: 0,
  grab: 0,
  openness: 0,
  gesture: 'idle',
  velocity: emptyVec(),
  timestamp: 0,
  landmarks: Array.from({ length: 21 }, emptyVec),
})

/**
 * What the hand pipeline actually costs, measured rather than guessed.
 *
 * This exists because "the cursor trails my hand" and "it shakes" are reports
 * about a system with five stages — camera exposure, inference, the One Euro
 * filter, the render-loop damp, and the draw — and no way to tell which one is
 * responsible. Tuning a filter constant against that description is guessing
 * with extra steps.
 *
 * Three numbers, because there are three different failures and they do not
 * respond to the same fix:
 *
 *   - `pipelineMs` is transport: the camera and the model. Nothing in this
 *     codebase can make it much smaller.
 *   - `lagMs` is smoothing. It is the one that produces a visible trail, and
 *     it is entirely ours — filter cutoffs and damp rates.
 *   - `jitterPx` is the noise floor smoothing is paid to suppress, so it is
 *     the budget the other two are spent from. Lowering lag without watching
 *     this is how you trade a trailing cursor for a shaking one.
 */
export interface HandMetrics {
  /**
   * `performance.now()` at which the current frame left the camera, 0 when
   * unknown. Set from `requestVideoFrameCallback`, which is the only source
   * that knows — `video.currentTime` is a media clock, not a wall clock.
   */
  capturedAt: number
  /** EMA, ms: capture until that frame's pose first moves the cursor. */
  pipelineMs: number
  /**
   * EMA, ms: how far behind the live target the drawn cursor actually is,
   * while the hand is moving. Distance over speed — the honest form of "it
   * trails", and the only one of the three that smoothing controls.
   */
  lagMs: number
  /** EMA, screen pixels: residual movement of the target while the hand is still. */
  jitterPx: number
}

export interface HandFrame {
  left: HandState
  right: HandState
  /** How many hands the landmarker saw this frame. */
  count: number
  /** Inference timestamp, seconds. */
  timestamp: number
  /** Measured inference cost in ms — surfaced in the HUD. */
  inferenceMs: number
  metrics: HandMetrics
}

/** Mutated in place. Never reassign the object or its hands. */
export const handFrame: HandFrame = {
  left: emptyHand('left'),
  right: emptyHand('right'),
  count: 0,
  timestamp: 0,
  inferenceMs: 0,
  metrics: { capturedAt: 0, pipelineMs: 0, lagMs: 0, jitterPx: 0 },
}

export const getHand = (handedness: Handedness): HandState => handFrame[handedness]

/** The hand currently driving interaction: right takes precedence when both are up. */
export const getPrimaryHand = (): HandState | null => {
  if (handFrame.right.visible) return handFrame.right
  if (handFrame.left.visible) return handFrame.left
  return null
}

export function resetHand(handedness: Handedness): void {
  const hand = handFrame[handedness]
  hand.visible = false
  hand.pinch = 0
  hand.grab = 0
  hand.openness = 0
  hand.gesture = 'idle'
  hand.velocity.x = 0
  hand.velocity.y = 0
  hand.velocity.z = 0
}

export function resetHandFrame(): void {
  resetHand('left')
  resetHand('right')
  handFrame.count = 0
  handFrame.inferenceMs = 0
  handFrame.metrics.capturedAt = 0
  handFrame.metrics.pipelineMs = 0
  handFrame.metrics.lagMs = 0
  handFrame.metrics.jitterPx = 0
}
