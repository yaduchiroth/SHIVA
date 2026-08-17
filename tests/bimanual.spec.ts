import { expect, test } from '@playwright/test'
import { BimanualRecognizer } from '@/spatial/hands/bimanual'
import { handFrame, resetHandFrame } from '@/core/hands/handFrame'
import { clearBus, on } from '@/core/events/bus'
import type { EventMap } from '@/core/events/bus'
import type { GestureName, Handedness } from '@/core/types'

/**
 * Two-handed gestures.
 *
 * These read the hand frame directly rather than going through the recognizer,
 * because the thing under test is the relationship BETWEEN two hands — the
 * per-hand classification is already covered in gestures.spec.ts and mocking it
 * here would only be testing that file twice.
 *
 * The cases that matter are the ones that would produce a wrong world rather
 * than no world: a stale reference point making the ring jump on re-grab, a
 * ratio of two nearly-touching hands sending the camera to infinity, and a
 * release that never fires leaving the space held.
 */

/** Places a hand in the frame with a given pose. */
function place(hand: Handedness, x: number, y: number, gesture: GestureName = 'pinch') {
  const state = handFrame[hand]
  state.visible = true
  state.gesture = gesture
  state.position.x = x
  state.position.y = y
}

/** Collects every event of one type emitted while running `body`. */
function capture<K extends keyof EventMap>(event: K, body: () => void): EventMap[K][] {
  const seen: EventMap[K][] = []
  const off = on(event, (payload) => seen.push(payload))
  body()
  off()
  return seen
}

test.beforeEach(() => {
  clearBus()
  resetHandFrame()
})

test.describe('engaging', () => {
  test('both hands pinched takes hold of the world', () => {
    const bimanual = new BimanualRecognizer()
    const grabs = capture('world:grab', () => {
      place('left', 0.35, 0.5)
      place('right', 0.65, 0.5)
      bimanual.update()
    })
    expect(grabs).toHaveLength(1)
    expect(bimanual.engaged).toBe(true)
  })

  test('one pinched hand does not', () => {
    // Single-hand pinch still means "grab a panel" and must be left alone.
    const bimanual = new BimanualRecognizer()
    const grabs = capture('world:grab', () => {
      place('right', 0.65, 0.5)
      bimanual.update()
    })
    expect(grabs).toHaveLength(0)
    expect(bimanual.engaged).toBe(false)
  })

  test('two visible hands that are not pinching do not', () => {
    const bimanual = new BimanualRecognizer()
    const grabs = capture('world:grab', () => {
      place('left', 0.35, 0.5, 'palm')
      place('right', 0.65, 0.5, 'palm')
      bimanual.update()
    })
    expect(grabs).toHaveLength(0)
  })

  test('grabbing is announced once, not every frame', () => {
    const bimanual = new BimanualRecognizer()
    const grabs = capture('world:grab', () => {
      place('left', 0.35, 0.5)
      place('right', 0.65, 0.5)
      for (let i = 0; i < 10; i++) bimanual.update()
    })
    expect(grabs).toHaveLength(1)
  })

  test('unpinching releases the world', () => {
    const bimanual = new BimanualRecognizer()
    place('left', 0.35, 0.5)
    place('right', 0.65, 0.5)
    bimanual.update()

    const releases = capture('world:release', () => {
      handFrame.left.gesture = 'idle'
      bimanual.update()
    })
    expect(releases).toHaveLength(1)
    expect(bimanual.engaged).toBe(false)
  })

  test('a hand leaving the frame releases the world', () => {
    // Tracking drops out constantly. A release that only fires on a clean
    // unpinch would leave the space held whenever a hand simply vanished.
    const bimanual = new BimanualRecognizer()
    place('left', 0.35, 0.5)
    place('right', 0.65, 0.5)
    bimanual.update()

    const releases = capture('world:release', () => {
      handFrame.left.visible = false
      bimanual.update()
    })
    expect(releases).toHaveLength(1)
  })

  test('reset releases a held world', () => {
    const bimanual = new BimanualRecognizer()
    place('left', 0.35, 0.5)
    place('right', 0.65, 0.5)
    bimanual.update()

    expect(capture('world:release', () => bimanual.reset())).toHaveLength(1)
  })

  test('reset on an idle recognizer stays quiet', () => {
    const bimanual = new BimanualRecognizer()
    expect(capture('world:release', () => bimanual.reset())).toHaveLength(0)
  })
})

test.describe('spin', () => {
  test('moving both hands turns the ring', () => {
    const bimanual = new BimanualRecognizer()
    place('left', 0.35, 0.5)
    place('right', 0.65, 0.5)
    bimanual.update() // engage
    bimanual.update() // establish the reference midpoint

    const spins = capture('world:spin', () => {
      place('left', 0.25, 0.5)
      place('right', 0.55, 0.5)
      bimanual.update()
    })
    expect(spins).toHaveLength(1)
    // x is mirrored, so hands moving toward lower x turn the ring positively.
    expect(spins[0]!.delta).toBeGreaterThan(0)
  })

  test('direction follows the hands', () => {
    const bimanual = new BimanualRecognizer()
    place('left', 0.35, 0.5)
    place('right', 0.65, 0.5)
    bimanual.update()
    bimanual.update()

    const spins = capture('world:spin', () => {
      place('left', 0.45, 0.5)
      place('right', 0.75, 0.5)
      bimanual.update()
    })
    expect(spins[0]!.delta).toBeLessThan(0)
  })

  test('holding still emits nothing', () => {
    // Hands held deliberately still drift by a fraction of a percent. Without a
    // dead zone that drift becomes the ring turning on its own.
    const bimanual = new BimanualRecognizer()
    place('left', 0.35, 0.5)
    place('right', 0.65, 0.5)
    bimanual.update()
    bimanual.update()

    const spins = capture('world:spin', () => {
      place('left', 0.3505, 0.5)
      place('right', 0.6505, 0.5)
      bimanual.update()
    })
    expect(spins).toHaveLength(0)
  })

  test('the first engaged frame emits nothing', () => {
    // There is no previous midpoint to measure against yet, and inventing one
    // would send a spurious delta on every grab.
    const bimanual = new BimanualRecognizer()
    const spins = capture('world:spin', () => {
      place('left', 0.35, 0.5)
      place('right', 0.65, 0.5)
      bimanual.update()
    })
    expect(spins).toHaveLength(0)
  })

  test('re-grabbing elsewhere does not jump', () => {
    // The failure this prevents: hands release, move across the frame, pinch
    // again — and a stale reference makes the ring lurch by the whole distance
    // travelled while not pinching.
    const bimanual = new BimanualRecognizer()
    place('left', 0.35, 0.5)
    place('right', 0.65, 0.5)
    bimanual.update()
    bimanual.update()

    handFrame.left.gesture = 'idle'
    bimanual.update() // release

    const spins = capture('world:spin', () => {
      place('left', 0.05, 0.5)
      place('right', 0.35, 0.5)
      bimanual.update() // re-engage far away
      bimanual.update()
    })
    expect(spins).toHaveLength(0)
  })
})

test.describe('zoom', () => {
  test('spreading hands apart pulls the camera closer', () => {
    const bimanual = new BimanualRecognizer()
    place('left', 0.35, 0.5)
    place('right', 0.65, 0.5)
    bimanual.update()
    bimanual.update()

    const zooms = capture('world:zoom', () => {
      place('left', 0.3, 0.5)
      place('right', 0.7, 0.5)
      bimanual.update()
    })
    expect(zooms).toHaveLength(1)
    // Below 1 multiplies distance down, which is closer.
    expect(zooms[0]!.factor).toBeLessThan(1)
  })

  test('bringing hands together pushes it away', () => {
    const bimanual = new BimanualRecognizer()
    place('left', 0.3, 0.5)
    place('right', 0.7, 0.5)
    bimanual.update()
    bimanual.update()

    const zooms = capture('world:zoom', () => {
      place('left', 0.38, 0.5)
      place('right', 0.62, 0.5)
      bimanual.update()
    })
    expect(zooms[0]!.factor).toBeGreaterThan(1)
  })

  test('a tracking glitch cannot teleport the camera', () => {
    // The factor is a ratio of successive separations, so one frame where the
    // tracker misplaces a hand yields an enormous number. Clamping per frame
    // costs nothing at human speed — nobody moves 18% in one sixtieth of a
    // second — and turns a violent glitch into an invisible one.
    const bimanual = new BimanualRecognizer()
    place('left', 0.1, 0.5)
    place('right', 0.9, 0.5)
    bimanual.update()
    bimanual.update()

    const zooms = capture('world:zoom', () => {
      place('left', 0.44, 0.5)
      place('right', 0.56, 0.5)
      bimanual.update()
    })
    expect(zooms[0]!.factor).toBeLessThanOrEqual(1.18)
    expect(zooms[0]!.factor).toBeGreaterThanOrEqual(0.85)
  })

  test('hands nearly touching emit no zoom', () => {
    // The ratio of two tiny separations is noise amplified.
    const bimanual = new BimanualRecognizer()
    place('left', 0.49, 0.5)
    place('right', 0.51, 0.5)
    bimanual.update()
    bimanual.update()

    const zooms = capture('world:zoom', () => {
      place('left', 0.485, 0.5)
      place('right', 0.515, 0.5)
      bimanual.update()
    })
    expect(zooms).toHaveLength(0)
  })

  test('separation is measured in both axes', () => {
    // Hands one above the other are just as far apart as hands side by side.
    const bimanual = new BimanualRecognizer()
    place('left', 0.5, 0.3)
    place('right', 0.5, 0.7)
    bimanual.update()
    bimanual.update()

    const zooms = capture('world:zoom', () => {
      place('left', 0.5, 0.25)
      place('right', 0.5, 0.75)
      bimanual.update()
    })
    expect(zooms[0]!.factor).toBeLessThan(1)
  })
})
