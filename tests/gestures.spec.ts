import { expect, test } from '@playwright/test'
import { HandRecognizer } from '@/spatial/hands/gestureRecognizer'
import { clearBus, on } from '@/core/events/bus'
import type { EventMap } from '@/core/events/bus'
import type { HandState } from '@/core/types'
import { POSES, handPose } from './handPose'

/**
 * The gesture recognizer, tested against synthetic hands.
 *
 * These are the tests that would have caught the two bugs this file was written
 * in response to: a grab gate whose threshold was unreachable, so a fist never
 * registered at all, and an open-palm threshold loose enough that a *relaxed*
 * hand satisfied it, arming accidental swipes.
 *
 * Neither was visible from the outside — no error, no warning, just an
 * interface that quietly ignored two of its four gestures.
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

/**
 * Feeds a pose until the One Euro filters settle.
 *
 * A single frame is not enough: positions are filtered before thresholding, so
 * the first sample of any pose is still partway from its predecessor. Real
 * hands hold a gesture for far longer than this.
 */
function hold(
  recognizer: HandRecognizer,
  points: ReturnType<typeof handPose>,
  frames = 12,
): HandState {
  const out = emptyHand()
  for (let i = 0; i < frames; i++) {
    recognizer.update(points, 0.1 + i / 30, out)
  }
  return out
}

test.describe('gesture recognition', () => {
  test.beforeEach(() => clearBus())

  test('classifies each pose it claims to support', () => {
    for (const [name, build] of Object.entries(POSES)) {
      const recognizer = new HandRecognizer('right')
      const state = hold(recognizer, build())

      const expected: Record<string, string> = {
        openPalm: 'palm',
        fist: 'grab',
        pinch: 'pinch',
        point: 'point',
        // A hand at rest must resolve to nothing. Anything else means the
        // interface reacts to a user who isn't asking for anything.
        relaxed: 'idle',
      }

      expect(state.gesture, `pose "${name}" misclassified`).toBe(expected[name])
    }
  })

  test('a fist registers as grab', () => {
    // The specific regression: the gate demanded a value the geometry could
    // never produce, so this gesture was dead on arrival.
    const state = hold(new HandRecognizer('right'), POSES.fist())
    expect(state.gesture).toBe('grab')
    expect(state.grab).toBeGreaterThan(0.8)
  })

  test('a relaxed hand is not an open palm', () => {
    // The other regression: resting hands satisfied the palm threshold, which
    // is what arms swipe detection.
    const state = hold(new HandRecognizer('right'), POSES.relaxed())
    expect(state.gesture).toBe('idle')
    expect(state.openness).toBeLessThan(0.9)
  })

  test('recognition is scale invariant', () => {
    // Every threshold is a ratio against palm size, so the same gesture must
    // read identically whether the hand is near the camera or far from it.
    // A recognizer tuned in absolute units works at exactly one distance.
    for (const origin of [
      { x: 0.2, y: 0.6 },
      { x: 0.8, y: 0.9 },
    ]) {
      const near = hold(
        new HandRecognizer('right'),
        handPose({ fingers: [1, 1, 1, 1], thumb: 0.9, origin }),
      )
      expect(near.gesture, `fist at ${JSON.stringify(origin)}`).toBe('grab')
    }
  })

  test('emits start and end events across a transition', () => {
    const started: EventMap['gesture:start'][] = []
    const ended: EventMap['gesture:end'][] = []
    on('gesture:start', (e) => started.push(e))
    on('gesture:end', (e) => ended.push(e))

    const recognizer = new HandRecognizer('right')
    const out = emptyHand()

    // Rest, then pinch, then rest again — grab, act, release.
    for (let i = 0; i < 12; i++) recognizer.update(POSES.relaxed(), 0.1 + i / 30, out)
    for (let i = 0; i < 12; i++) recognizer.update(POSES.pinch(), 0.5 + i / 30, out)
    for (let i = 0; i < 12; i++) recognizer.update(POSES.relaxed(), 0.9 + i / 30, out)

    expect(started.map((e) => e.gesture)).toContain('pinch')
    expect(ended.map((e) => e.gesture)).toContain('pinch')
    // Every start must be matched by an end, or a panel stays grabbed forever.
    expect(ended.length).toBe(started.length)
  })

  test('an open palm swept sideways fires exactly one swipe', () => {
    const swipes: EventMap['gesture:swipe'][] = []
    on('gesture:swipe', (e) => swipes.push(e))

    const recognizer = new HandRecognizer('right')
    const out = emptyHand()

    // Settle first: velocity is measured between frames, so a pose appearing
    // from nothing would read as infinite speed.
    for (let i = 0; i < 10; i++) {
      recognizer.update(handPose({ origin: { x: 0.25, y: 0.7 } }), i / 30, out)
    }

    // Sweep left-to-right across the frame over ~0.27s — a deliberate swipe.
    for (let i = 0; i < 8; i++) {
      const x = 0.25 + (i + 1) * 0.05
      recognizer.update(handPose({ origin: { x, y: 0.7 } }), (10 + i) / 30, out)
    }

    expect(swipes.length, 'a single sweep must not fire repeatedly').toBe(1)
    // Tracking x is mirrored on screen, so moving right in tracking space
    // travels left visually. The consumer needs screen-space direction.
    expect(swipes[0]!.direction).toBe(-1)
  })

  test('a slow drift does not fire a swipe', () => {
    const swipes: EventMap['gesture:swipe'][] = []
    on('gesture:swipe', (e) => swipes.push(e))

    const recognizer = new HandRecognizer('right')
    const out = emptyHand()
    // Same distance, but over 2 seconds instead of 0.27 — someone repositioning
    // their hand, not gesturing with it.
    for (let i = 0; i < 60; i++) {
      recognizer.update(handPose({ origin: { x: 0.25 + i * 0.007, y: 0.7 } }), i / 30, out)
    }

    expect(swipes.length, 'repositioning must not read as a command').toBe(0)
  })

  test('a fist swept sideways does not swipe', () => {
    // Swipe requires an open palm precisely so that carrying a grabbed panel
    // across the frame doesn't also rotate the ring underneath it.
    const swipes: EventMap['gesture:swipe'][] = []
    on('gesture:swipe', (e) => swipes.push(e))

    const recognizer = new HandRecognizer('right')
    const out = emptyHand()
    for (let i = 0; i < 10; i++) {
      recognizer.update(
        handPose({ fingers: [1, 1, 1, 1], thumb: 0.9, origin: { x: 0.25, y: 0.7 } }),
        i / 30,
        out,
      )
    }
    for (let i = 0; i < 8; i++) {
      const x = 0.25 + (i + 1) * 0.05
      recognizer.update(
        handPose({ fingers: [1, 1, 1, 1], thumb: 0.9, origin: { x, y: 0.7 } }),
        (10 + i) / 30,
        out,
      )
    }

    expect(swipes.length).toBe(0)
  })
})
