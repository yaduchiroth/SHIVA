import { test } from '@playwright/test'
import { LM, POSES, handPose } from './handPose'

/**
 * Diagnostic, not an assertion. Prints the raw ratios the gesture recognizer
 * derives from each pose so thresholds can be set from measurements rather than
 * guessed. Run with: npx playwright test calibrate --reporter=list
 */

const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, (a.z - b.z) * 0.5)

function metrics(points: ReturnType<typeof handPose>) {
  const wrist = points[LM.WRIST]!
  const scale = Math.max(dist(wrist, points[LM.MIDDLE_MCP]!), 0.02)

  const curl =
    (dist(points[LM.INDEX_TIP]!, wrist) +
      dist(points[LM.MIDDLE_TIP]!, wrist) +
      dist(points[LM.RING_TIP]!, wrist) +
      dist(points[LM.PINKY_TIP]!, wrist)) /
    (4 * scale)

  return {
    scale: scale.toFixed(3),
    pinchRatio: (dist(points[LM.THUMB_TIP]!, points[LM.INDEX_TIP]!) / scale).toFixed(3),
    curl: curl.toFixed(3),
    indexExtension: (dist(points[LM.INDEX_TIP]!, wrist) / scale).toFixed(3),
    othersCurl: (
      (dist(points[LM.MIDDLE_TIP]!, wrist) +
        dist(points[LM.RING_TIP]!, wrist) +
        dist(points[LM.PINKY_TIP]!, wrist)) /
      (3 * scale)
    ).toFixed(3),
  }
}

test('calibration: pose metrics', () => {
  const rows = Object.entries(POSES).map(([name, build]) => ({ pose: name, ...metrics(build()) }))
  console.log('\n' + JSON.stringify(rows, null, 2))
})
