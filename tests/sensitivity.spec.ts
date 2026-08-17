import { expect, test } from '@playwright/test'
import { HandRecognizer } from '@/spatial/hands/gestureRecognizer'
import { SENSITIVITY, setSensitivity, type SensitivityName } from '@/core/config/sensitivity'
import { clearBus } from '@/core/events/bus'
import type { HandState } from '@/core/types'
import { LM, POSES, handPose } from './handPose'

/**
 * Sensitivity profiles.
 *
 * The bug these exist to prevent, stated plainly: a hand hanging at rest
 * measures about 1.54 palm widths from wrist to fingertip, and the original
 * dead zone ran 1.35 to 1.70. That is a tenth of a palm width of clearance on
 * either side of doing nothing. Any real hand that curls slightly more than the
 * synthetic model, or straightens slightly less, spends its resting life
 * brushing a threshold — and the interface fires gestures nobody made.
 *
 * So the assertions here are about MARGIN, not just classification. A test that
 * only checks "a fist reads as a grab" passes happily with a dead zone one
 * millimetre wide.
 */

function emptyHand(): HandState {
  return {
    visible: false,
    handedness: 'right',
    position: { x: 0, y: 0, z: 0 },
    tip: { x: 0, y: 0, z: 0 },
    pinch: 0,
    grab: 0,
    openness: 0,
    gesture: 'idle',
    velocity: { x: 0, y: 0, z: 0 },
    timestamp: 0,
    landmarks: Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 })),
  }
}

function hold(recognizer: HandRecognizer, points: ReturnType<typeof handPose>, frames = 14) {
  const out = emptyHand()
  for (let i = 0; i < frames; i++) recognizer.update(points, 0.1 + i / 30, out)
  return out
}

/** Fingertip→wrist over palm scale, the quantity every threshold is stated in. */
function extension(points: ReturnType<typeof handPose>, tip: number): number {
  const wrist = points[LM.WRIST]!
  const mcp = points[LM.MIDDLE_MCP]!
  const d = (a: typeof wrist, b: typeof wrist) =>
    Math.hypot(a.x - b.x, a.y - b.y, (a.z - b.z) * 0.5)
  return d(points[tip]!, wrist) / Math.max(d(wrist, mcp), 0.02)
}

const PROFILES: SensitivityName[] = ['low', 'normal', 'high']

test.beforeEach(() => clearBus())
test.afterEach(() => setSensitivity('normal'))

test.describe('the resting hand', () => {
  test('sits inside the dead zone on every profile', () => {
    // The property that matters most: doing nothing must read as nothing,
    // whatever the profile.
    for (const name of PROFILES) {
      setSensitivity(name)
      const gesture = hold(new HandRecognizer('right'), POSES.relaxed()).gesture
      expect(gesture, `relaxed hand fired "${gesture}" on the ${name} profile`).toBe('idle')
    }
  })

  test('the default leaves real clearance on both sides', () => {
    // The original tuning passed the test above and still misbehaved on real
    // hands, because it passed by a hair. This asserts the hair is now a
    // margin: at least 15% of the resting value to either threshold.
    const relaxed = POSES.relaxed()
    const index = extension(relaxed, LM.INDEX_TIP)
    const middle = extension(relaxed, LM.MIDDLE_TIP)
    const { extended, curled } = SENSITIVITY.normal

    expect(extended - index).toBeGreaterThan(index * 0.15)
    expect(middle - curled).toBeGreaterThan(middle * 0.15)
  })

  test('the old tuning is retained, and demonstrably tighter', () => {
    // Kept as `high` so the regression is visible rather than folklore.
    const relaxed = POSES.relaxed()
    const index = extension(relaxed, LM.INDEX_TIP)
    expect(SENSITIVITY.high.extended - index).toBeLessThan(index * 0.15)
    expect(SENSITIVITY.normal.extended - index).toBeGreaterThan(SENSITIVITY.high.extended - index)
  })
})

test.describe('deliberate poses still register', () => {
  test('widening the dead zone did not cost any gesture', () => {
    // The trade would be real if deliberate poses sat near the boundary. They
    // do not — a fist is at 0.88 and an open palm at 2.08, both far outside
    // even the widest profile.
    for (const name of PROFILES) {
      setSensitivity(name)
      expect(hold(new HandRecognizer('right'), POSES.fist()).gesture, name).toBe('grab')
      expect(hold(new HandRecognizer('right'), POSES.openPalm()).gesture, name).toBe('palm')
      expect(hold(new HandRecognizer('right'), POSES.pinch()).gesture, name).toBe('pinch')
      expect(hold(new HandRecognizer('right'), POSES.point()).gesture, name).toBe('point')
    }
  })
})

test.describe('profile ordering', () => {
  test('each step down widens the dead zone', () => {
    const width = (n: SensitivityName) => SENSITIVITY[n].extended - SENSITIVITY[n].curled
    expect(width('low')).toBeGreaterThan(width('normal'))
    expect(width('normal')).toBeGreaterThan(width('high'))
  })

  test('each step down asks for a more deliberate swipe', () => {
    expect(SENSITIVITY.low.swipeSpeed).toBeGreaterThan(SENSITIVITY.normal.swipeSpeed)
    expect(SENSITIVITY.normal.swipeSpeed).toBeGreaterThan(SENSITIVITY.high.swipeSpeed)
  })

  test('each step down turns the ring less per unit of hand travel', () => {
    expect(SENSITIVITY.low.spinGain).toBeLessThan(SENSITIVITY.normal.spinGain)
    expect(SENSITIVITY.normal.spinGain).toBeLessThan(SENSITIVITY.high.spinGain)
  })

  test('the default swipe threshold is above casual hand movement', () => {
    // Repositioning a hand runs near 1 normalised unit/sec; a deliberate sweep
    // is around 2. The old 0.9 sat below casual, which is exactly why the
    // carousel stepped while the user was only moving their hand.
    expect(SENSITIVITY.normal.swipeSpeed).toBeGreaterThan(1.2)
    expect(SENSITIVITY.normal.swipeSpeed).toBeLessThan(2)
  })
})

test.describe('switching profiles', () => {
  test('takes effect on a recognizer that already exists', () => {
    // Profiles are read per frame rather than captured in the constructor, so
    // changing one does not require restarting the camera.
    const recognizer = new HandRecognizer('right')
    setSensitivity('high')
    expect(hold(recognizer, POSES.fist()).gesture).toBe('grab')
    setSensitivity('low')
    expect(hold(recognizer, POSES.fist()).gesture).toBe('grab')
  })
})
