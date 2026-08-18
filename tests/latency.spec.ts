import { expect, test } from '@playwright/test'

/**
 * The latency instrument, wired into the real render loop.
 *
 * Deliberately narrow. The arithmetic is checked exactly in
 * `pipelineMeter.spec` — against a closed form, at frame rates chosen rather
 * than suffered — and repeating that here would only produce a weaker version
 * of the same assertion. There is no GPU in CI: frames arrive about twice a
 * second, `dt` is ten times the damp's time constant, and the exponential
 * average over the readout never settles. A numeric expectation in this
 * environment would have to be so wide it asserted nothing, which is worse
 * than not asserting it.
 *
 * What this file is for is everything the unit test cannot see: that the meter
 * is actually connected, fed from the cursor that draws, reset when a hand
 * leaves, and reachable. Both halves have been wrong before — a first version
 * of the still-hand guard passed its unit test while the component silently
 * never called it.
 */

test.describe('hand pipeline latency', () => {
  test('measures a moving hand and reports it', async ({ page }) => {
    test.setTimeout(180_000)
    await page.goto('/?quality=low&capture=1&dev=1&mind=off')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await page.waitForFunction(() => Boolean(window.__shiva), null, { timeout: 30_000 })

    // Swept on rAF rather than on a timer, so the hand moves in lockstep with
    // the render loop chasing it. A `setInterval` would deliver positions at
    // times unrelated to when frames are drawn, and the cursor would be
    // measured against a hand that had teleported between frames.
    const lag = await page.evaluate(async () => {
      const hand = window.__shiva!.hand
      return await new Promise<number>((resolve) => {
        const started = performance.now()
        const DURATION = 8000
        const step = (now: number) => {
          const t = (now - started) / DURATION
          if (t >= 1) {
            resolve(window.__shiva!.metrics().lagMs)
            return
          }
          // Back and forth across the middle of the frame, so the hand is
          // moving for most of the run whatever the frame rate turns out to be.
          hand({ x: 0.5 + Math.sin(t * Math.PI * 4) * 0.2, y: 0.5, gesture: 'point' })
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })
    })

    // Connected at all, and producing a figure from this planet. The unit test
    // owns the question of whether it is the *right* figure.
    expect(lag, 'the meter is not wired to the cursor').toBeGreaterThan(0)
    expect(lag, 'no camera-to-screen path takes a second').toBeLessThan(1000)
  })

  test('reports nothing for a hand that never moves', async ({ page }) => {
    // The failure that would matter most in the field: lag is distance over
    // speed, and a hand resting on a desk divides by almost nothing. If that
    // reached the HUD it would show hundreds of milliseconds of trail for a
    // motionless hand and send the next person tuning filters to fix a problem
    // that does not exist.
    test.setTimeout(120_000)
    await page.goto('/?quality=low&capture=1&dev=1&mind=off')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await page.waitForFunction(() => Boolean(window.__shiva), null, { timeout: 30_000 })

    const result = await page.evaluate(async () => {
      const hand = window.__shiva!.hand
      return await new Promise<{ lagMs: number; jitterPx: number }>((resolve) => {
        const started = performance.now()
        const step = () => {
          if (performance.now() - started > 5000) {
            resolve(window.__shiva!.metrics())
            return
          }
          hand({ x: 0.5, y: 0.5, gesture: 'point' })
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })
    })

    // Zero is how the HUD knows to render a dash rather than a figure.
    expect(result.lagMs, 'a motionless hand cannot have a trail').toBe(0)
    // Nothing upstream is adding noise here, so the floor must be flat. This is
    // the baseline a real camera's jitter gets read against.
    expect(result.jitterPx, 'a motionless hand cannot shake').toBeLessThan(0.01)
  })

  test('a hand that leaves and returns is not measured across the gap', async ({ page }) => {
    // Without the reset, the last position before the hand vanished is
    // compared against the first position after it returns — one frame
    // apparently covering the width of the screen, reported as a lag figure
    // from a movement that never happened.
    test.setTimeout(120_000)
    await page.goto('/?quality=low&capture=1&dev=1&mind=off')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await page.waitForFunction(() => Boolean(window.__shiva), null, { timeout: 30_000 })

    const jump = await page.evaluate(async () => {
      const hand = window.__shiva!.hand
      const frame = () => new Promise((r) => requestAnimationFrame(r))

      // Settle on one side.
      for (let i = 0; i < 30; i++) {
        hand({ x: 0.2, y: 0.5, gesture: 'point' })
        await frame()
      }
      // Gone.
      hand(null)
      for (let i = 0; i < 30; i++) await frame()
      // Back, on the far side of the frame.
      for (let i = 0; i < 30; i++) {
        hand({ x: 0.8, y: 0.5, gesture: 'point' })
        await frame()
      }
      return window.__shiva!.metrics()
    })

    expect(jump.lagMs, 'the gap was measured as movement').toBe(0)
  })
})
