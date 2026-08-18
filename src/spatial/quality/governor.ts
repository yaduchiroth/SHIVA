import type { QualityTier } from '@/lib/device'

/**
 * The rule the runtime quality governor follows.
 *
 * Extracted from the component because it was untested, and because what it got
 * wrong was invisible from the outside: the interface simply looked bad, and
 * "looks bad" does not point anywhere. Three separate complaints — pixelated UI,
 * low-quality animation, gestures that felt unresponsive — were all one
 * downgrade, taken during the only moment the frame rate is guaranteed to be
 * terrible.
 *
 * A GPU compiles every shader in the scene the first time it renders it. On this
 * scene that costs seconds, and the old rule read those seconds as evidence
 * about the machine's steady-state capability. It is not evidence about anything
 * except shader compilation, which happens once.
 *
 * The tier is not a cosmetic setting. `quality.ts` ties `trackingHz` to it, so a
 * spurious downgrade samples hands at 20 Hz instead of 60 — a third of the rate
 * the gesture thresholds were calibrated against. The recognizer looks broken
 * and nothing is wrong with it.
 */

export const ORDER: QualityTier[] = ['low', 'medium', 'high']

/** Below this, sustained, the tier steps down. */
export const DOWNGRADE_FPS = 42
/** Above this, the tier may step back up toward the probed one. */
export const UPGRADE_FPS = 58

/**
 * How long the scene renders before any measurement counts.
 *
 * Long enough to cover shader compilation on a cold GPU. Being generous costs
 * nothing — the tier simply stays where device probing put it, which is the best
 * available guess until there is real evidence — while being ungenerous costs
 * exactly the bug this replaces.
 */
export const WARMUP_MS = 6000

/**
 * Consecutive slow windows required to step down.
 *
 * The previous implementation acted on one, while its own comment claimed
 * otherwise. One window is a garbage collection, a background tab waking, or a
 * texture upload.
 */
export const SLOW_WINDOWS_TO_DOWNGRADE = 2

/**
 * Windows to ignore after any tier change.
 *
 * Changing tier swaps the effect chain, which triggers a fresh round of shader
 * compilation — so the window immediately after a downgrade is biased toward
 * measuring another one. That feedback loop is what turned a single slow boot
 * into a two-step fall from high to low.
 */
export const SETTLE_MS = 2500

/**
 * Cooldown before stepping back up.
 *
 * Short, deliberately. It exists only to damp oscillation, and the settle window
 * and the consecutive-window requirement above already do that far better than
 * waiting does. The old twelve seconds per step meant a machine that recovered
 * instantly still spent almost half a minute looking broken.
 */
export const UPGRADE_COOLDOWN_MS = 5000

export interface GovernorInput {
  /** Frames per second measured over the window that just closed. */
  fps: number
  /** The tier in force. */
  tier: QualityTier
  /** What device probing chose. The governor never rises above it. */
  baseTier: QualityTier
  /** `?quality=` was given: an instruction, not a suggestion. */
  pinned: boolean
  /** Since the scene started rendering. */
  msSinceStart: number
  /** Since the tier last moved. */
  msSinceChange: number
  /** Consecutive slow windows already seen, not counting this one. */
  slowWindows: number
}

export interface GovernorDecision {
  action: 'up' | 'down' | 'hold'
  /** Tier to apply; equals the current tier when holding. */
  tier: QualityTier
  /** Consecutive slow-window count to carry into the next window. */
  slowWindows: number
  /** Why, in a few words — surfaced in the HUD and useful in a log. */
  reason: string
}

const hold = (tier: QualityTier, slowWindows: number, reason: string): GovernorDecision => ({
  action: 'hold',
  tier,
  slowWindows,
  reason,
})

/**
 * Decides what to do with the quality tier after one measurement window.
 *
 * Pure: everything it knows arrives in the argument, so every branch is
 * reachable from a test rather than from a slow GPU on someone else's desk.
 */
export function decideTier(input: GovernorInput): GovernorDecision {
  const { fps, tier, baseTier, pinned, msSinceStart, msSinceChange, slowWindows } = input

  if (pinned) return hold(tier, 0, 'pinned')

  // Shader compilation, not capability. The reported bug in one branch.
  if (msSinceStart < WARMUP_MS) return hold(tier, 0, 'warming up')

  // The chain just changed underneath us; this window measures that change.
  if (msSinceChange < SETTLE_MS) return hold(tier, 0, 'settling after a change')

  const current = ORDER.indexOf(tier)
  const ceiling = ORDER.indexOf(baseTier)

  if (fps < DOWNGRADE_FPS) {
    if (current <= 0) return hold(tier, 0, 'already at the lowest tier')

    const consecutive = slowWindows + 1
    if (consecutive < SLOW_WINDOWS_TO_DOWNGRADE) {
      // Counted, not acted on. One slow window is noise.
      return hold(tier, consecutive, `slow (${consecutive}/${SLOW_WINDOWS_TO_DOWNGRADE})`)
    }

    return {
      action: 'down',
      tier: ORDER[current - 1]!,
      slowWindows: 0,
      reason: `sustained ${Math.round(fps)} fps`,
    }
  }

  // Any window at or above the threshold clears the run — a downgrade should
  // need consecutive evidence, not a tally accumulated over a whole session.
  if (fps > UPGRADE_FPS && current < ceiling && msSinceChange > UPGRADE_COOLDOWN_MS) {
    return {
      action: 'up',
      tier: ORDER[current + 1]!,
      slowWindows: 0,
      reason: `headroom at ${Math.round(fps)} fps`,
    }
  }

  return hold(tier, 0, 'steady')
}
