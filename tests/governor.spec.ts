import { expect, test } from '@playwright/test'
import {
  DOWNGRADE_FPS,
  SETTLE_MS,
  UPGRADE_COOLDOWN_MS,
  UPGRADE_FPS,
  WARMUP_MS,
  decideTier,
  type GovernorInput,
} from '@/spatial/quality/governor'

/**
 * The quality governor's rule.
 *
 * Written after it shipped a bug that produced three unrelated-looking
 * complaints — pixelated UI, low-quality animation, unresponsive gestures — from
 * one cause: it read the seconds a GPU spends compiling shaders on first render
 * as evidence about the machine, and walked the tier from high to low before the
 * boot sequence finished.
 *
 * None of that was visible as a fault. The interface simply looked bad, and
 * "looks bad" points nowhere. The logic lived inside a `useFrame` closure where
 * nothing could reach it, so the first test here is the reported bug itself.
 */

const base = (over: Partial<GovernorInput> = {}): GovernorInput => ({
  fps: 60,
  tier: 'high',
  baseTier: 'high',
  pinned: false,
  msSinceStart: WARMUP_MS + 1000,
  msSinceChange: UPGRADE_COOLDOWN_MS + 1000,
  slowWindows: 0,
  ...over,
})

test.describe('the reported bug', () => {
  test('boot-speed frames inside the warm-up window change nothing', () => {
    // Every shader in the scene compiles on first render. The frame rate during
    // that is a fact about compilation, not about the machine — and it was the
    // ONLY evidence the old rule ever got before it acted.
    const decision = decideTier(base({ fps: 4, msSinceStart: 500 }))
    expect(decision.action).toBe('hold')
    expect(decision.tier).toBe('high')
  })

  test('holds for the whole warm-up window, not just the first frame', () => {
    for (const ms of [0, 1000, 3000, WARMUP_MS - 1]) {
      expect(decideTier(base({ fps: 3, msSinceStart: ms })).action, `at ${ms}ms`).toBe('hold')
    }
  })

  test('a slow window does count once the scene has warmed up', () => {
    // The gate must delay judgement, not disable it. A genuinely slow machine
    // still needs the tier lowered.
    const decision = decideTier(base({ fps: 20, msSinceStart: WARMUP_MS + 1 }))
    expect(decision.slowWindows).toBe(1)
  })
})

test.describe('sustained evidence', () => {
  test('one slow window is not enough', () => {
    // A garbage collection, a background tab waking, a texture upload. The old
    // implementation acted on this while its own comment claimed it did not.
    const decision = decideTier(base({ fps: 20 }))
    expect(decision.action).toBe('hold')
    expect(decision.slowWindows).toBe(1)
  })

  test('two consecutive slow windows step the tier down', () => {
    const decision = decideTier(base({ fps: 20, slowWindows: 1 }))
    expect(decision.action).toBe('down')
    expect(decision.tier).toBe('medium')
    expect(decision.reason).toContain('sustained')
  })

  test('a good window clears the run', () => {
    // Otherwise a tally accumulated across a whole session eventually trips on
    // two slow windows an hour apart, which is not "sustained" in any sense.
    expect(decideTier(base({ fps: 60, slowWindows: 1 })).slowWindows).toBe(0)
  })

  test('the counter resets after acting, so each step needs its own evidence', () => {
    expect(decideTier(base({ fps: 20, slowWindows: 1 })).slowWindows).toBe(0)
  })
})

test.describe('settling after a change', () => {
  test('the window straight after a change is ignored whatever it says', () => {
    // Changing tier swaps the effect chain and triggers fresh compilation, so
    // this window is biased toward measuring another downgrade. That feedback
    // loop is what turned one slow boot into a two-step fall to the bottom.
    const decision = decideTier(base({ fps: 2, slowWindows: 1, msSinceChange: 100 }))
    expect(decision.action).toBe('hold')
    expect(decision.reason).toContain('settling')
  })

  test('and it does not bank the slow window either', () => {
    expect(decideTier(base({ fps: 2, slowWindows: 1, msSinceChange: 100 })).slowWindows).toBe(0)
  })

  test('measurement resumes once settled', () => {
    const decision = decideTier(base({ fps: 20, slowWindows: 1, msSinceChange: SETTLE_MS + 1 }))
    expect(decision.action).toBe('down')
  })
})

test.describe('bounds', () => {
  test('never goes below the lowest tier', () => {
    const decision = decideTier(base({ fps: 2, tier: 'low', baseTier: 'high', slowWindows: 5 }))
    expect(decision.action).toBe('hold')
  })

  test('never rises above what device probing chose', () => {
    // The probe knows things the frame rate does not — a software rasteriser can
    // be perfectly steady and still be the wrong thing to give god rays to.
    const decision = decideTier(base({ fps: 120, tier: 'medium', baseTier: 'medium' }))
    expect(decision.action).toBe('hold')
  })

  test('recovers toward the probed tier when there is headroom', () => {
    const decision = decideTier(base({ fps: 120, tier: 'low', baseTier: 'high' }))
    expect(decision.action).toBe('up')
    expect(decision.tier).toBe('medium')
  })

  test('recovery waits out the cooldown', () => {
    const decision = decideTier(
      base({ fps: 120, tier: 'low', baseTier: 'high', msSinceChange: UPGRADE_COOLDOWN_MS - 1 }),
    )
    expect(decision.action).toBe('hold')
  })

  test('the band between the thresholds moves nothing', () => {
    // Anything here is fine as it is; acting would be oscillation for its own
    // sake.
    const between = (DOWNGRADE_FPS + UPGRADE_FPS) / 2
    expect(decideTier(base({ fps: between, tier: 'low', baseTier: 'high' })).action).toBe('hold')
  })
})

test.describe('a pinned tier', () => {
  test('is an instruction, not a suggestion', () => {
    // `?quality=` is how someone inspects a specific tier. Overriding it would
    // make the one tool for diagnosing this class of problem unreliable.
    for (const fps of [1, 30, 60, 200]) {
      expect(decideTier(base({ fps, tier: 'high', pinned: true })).action, `at ${fps}fps`).toBe(
        'hold',
      )
    }
  })
})

test.describe('the warm-up window itself', () => {
  test('is long enough to cover shader compilation', () => {
    // Being generous costs nothing — the tier stays where probing put it, which
    // is the best guess available until there is real evidence. Being ungenerous
    // costs exactly the bug this file exists for.
    expect(WARMUP_MS).toBeGreaterThanOrEqual(4000)
  })

  test('recovery is not slower than a first impression', () => {
    // Two steps at the old 12s cooldown was 24 seconds of looking broken on a
    // machine that had already recovered.
    expect(UPGRADE_COOLDOWN_MS).toBeLessThanOrEqual(6000)
  })
})
