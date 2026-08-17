import type { Landmark } from '@/spatial/hands/gestureRecognizer'

/**
 * A synthetic hand, for testing the gesture recognizer without a camera.
 *
 * There is no way to point a webcam at a real hand in CI, and the fake-video
 * device Chromium offers shows a rolling colour pattern, not a hand — MediaPipe
 * finds nothing in it. So the landmarks are generated instead.
 *
 * The point is not photorealism; the recognizer only ever consumes distances
 * between landmarks. What matters is that those distances have the same
 * *proportions* a real hand produces, because every threshold in the recognizer
 * is expressed as a ratio against hand scale (wrist → middle knuckle). Get the
 * proportions right and the thresholds calibrated here hold for real hands.
 *
 * Proportions used, all relative to that palm scale, from standard hand
 * anthropometry:
 *   - extended fingertip sits ~2.2x palm scale from the wrist
 *   - fully curled fingertip sits ~0.9x — inside the knuckle row
 *   - thumb tip reaches ~1.3x when extended
 */

/** MediaPipe's 21-point topology. */
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const

/** Palm scale in normalised video units — a hand at a comfortable distance. */
const SCALE = 0.2

export interface HandPoseOptions {
  /** Per-finger curl, 0 = straight, 1 = fully closed. [index, middle, ring, pinky] */
  fingers?: [number, number, number, number]
  /** Thumb curl, 0 = extended away from palm, 1 = folded across it. */
  thumb?: number
  /** Overrides the thumb so its tip meets the index tip. */
  pinch?: boolean
  /** Where the wrist sits in normalised video space. */
  origin?: { x: number; y: number }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * Builds 21 landmarks for a pose.
 *
 * Fingers point "up" the frame (−y in video space, where y counts downward).
 * Curling shortens the wrist-to-tip distance and swings the tip back toward the
 * palm, which is what a real finger does and what the recognizer measures.
 */
export function handPose({
  fingers = [0, 0, 0, 0],
  thumb = 0,
  pinch = false,
  origin = { x: 0.5, y: 0.75 },
}: HandPoseOptions = {}): Landmark[] {
  const points: Landmark[] = new Array(21)
  const put = (i: number, x: number, y: number, z = 0) => {
    points[i] = { x: origin.x + x, y: origin.y + y, z }
  }

  put(LM.WRIST, 0, 0)

  // Knuckle row. Middle MCP defines the palm scale the recognizer normalises by.
  const mcp: Record<number, { x: number; y: number }> = {
    [LM.INDEX_MCP]: { x: -0.055 * 5, y: -0.19 * 5 },
    [LM.MIDDLE_MCP]: { x: 0, y: -1 },
    [LM.RING_MCP]: { x: 0.05 * 5, y: -0.19 * 5 },
    [LM.PINKY_MCP]: { x: 0.09 * 5, y: -0.165 * 5 },
  }
  for (const [index, p] of Object.entries(mcp)) {
    put(Number(index), p.x * SCALE, p.y * SCALE)
  }

  // Four fingers. Each joint is placed along a direction that rotates back
  // toward the palm as curl increases.
  const chains: [number, number, number, number][] = [
    [LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_DIP, LM.INDEX_TIP],
    [LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_DIP, LM.MIDDLE_TIP],
    [LM.RING_MCP, LM.RING_PIP, LM.RING_DIP, LM.RING_TIP],
    [LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_DIP, LM.PINKY_TIP],
  ]
  // Middle is longest, pinky shortest.
  const reach = [2.15, 2.3, 2.1, 1.85]

  chains.forEach((chain, f) => {
    const curl = fingers[f] ?? 0
    const base = points[chain[0]]!
    // Extended tips sit at `reach` palm-scales from the wrist; curled ones pull
    // inside the knuckle row.
    const tipDistance = lerp(reach[f]!, 0.88, curl) * SCALE
    // Direction swings from straight up toward the palm as the finger closes.
    const angle = lerp(-Math.PI / 2, -Math.PI / 2 + 2.0, curl)

    for (let j = 1; j < 4; j++) {
      const t = j / 3
      const d = lerp(Math.hypot(base.x - origin.x, base.y - origin.y), tipDistance, t)
      const a = lerp(-Math.PI / 2, angle, t)
      put(chain[j]!, Math.cos(a) * d, Math.sin(a) * d)
    }
  })

  // Thumb: extends out to the side rather than up, and folds across the palm.
  const thumbChain = [LM.THUMB_CMC, LM.THUMB_MCP, LM.THUMB_IP, LM.THUMB_TIP]
  const thumbReach = lerp(1.35, 0.75, thumb) * SCALE
  const thumbAngle = lerp(-Math.PI * 0.78, -Math.PI * 0.5, thumb)
  thumbChain.forEach((index, j) => {
    const t = (j + 1) / 4
    put(index, Math.cos(thumbAngle) * thumbReach * t, Math.sin(thumbAngle) * thumbReach * t)
  })

  if (pinch) {
    // Thumb tip meets index tip — the defining geometry of a pinch, and the one
    // thing the pinch test must not get wrong.
    const indexTip = points[LM.INDEX_TIP]!
    points[LM.THUMB_TIP] = { x: indexTip.x + 0.004, y: indexTip.y + 0.004, z: 0 }
  }

  return points
}

/** Common poses, named as the recognizer names them. */
export const POSES = {
  openPalm: () => handPose({ fingers: [0, 0, 0, 0], thumb: 0 }),
  fist: () => handPose({ fingers: [1, 1, 1, 1], thumb: 0.9 }),
  pinch: () => handPose({ fingers: [0.25, 0.1, 0.1, 0.1], thumb: 0.3, pinch: true }),
  point: () => handPose({ fingers: [0, 1, 1, 1], thumb: 0.8 }),
  relaxed: () => handPose({ fingers: [0.45, 0.45, 0.5, 0.5], thumb: 0.4 }),
} as const
