import { expect, test } from '@playwright/test'
import { samplePaint, sampleSharpness } from './helpers'

/**
 * Every quality tier renders, and renders sharply.
 *
 * Tiers mount genuinely different effect chains — the high tier adds god rays
 * and chromatic aberration on top of everything below it, each of which can
 * fail to compile independently. Without this, a tier nobody develops on can
 * break and stay broken until it reaches someone whose GPU happens to select
 * it.
 *
 * The sharpness assertion is here rather than in render.spec because the tier
 * is exactly what decides it: the effects that can turn the frame to mush are
 * the ones only the upper tiers mount, so the tier nobody develops on is again
 * the one at risk.
 *
 * Slow under software rasterisation, so the generous timeout is deliberate.
 */

const TIERS = ['low', 'medium', 'high'] as const

/**
 * How strong the sharpest edges in the centre crop must be, 0–255.
 *
 * Calibrated by measuring both conditions rather than by choosing a number that
 * sounded right. With depth of field temporarily reinstated at its old
 * settings, p99.5 read 35; without it, 152 / 147 / 148 across low / medium /
 * high. 80 sits between: 2.3x above the blurred reading, 1.8x below the
 * weakest sharp one.
 *
 * The first metric tried was the *fraction* of pixels carrying an edge, and it
 * was useless — 0.176 blurred against 0.186 sharp. The grain pass runs after
 * everything else, so a completely blurred frame still has an edge at nearly
 * every pixel; they are simply all weak. Blur does not remove edges, it
 * flattens them, so the statistic has to be about edge *strength*. That
 * distinction is only visible if you measure the broken case, and a test
 * written from the intuition alone would have shipped green with the bug live.
 *
 * This is a smoke alarm for "the whole frame went soft", not a fidelity score.
 */
const SHARPNESS_FLOOR = 80

const BENIGN = [
  /Download the React DevTools/i,
  /WebGL.*performance caveat/i,
  /SwiftShader/i,
  /GPU stall/i,
  /THREE\.Clock: This module has been deprecated/i,
  /using deprecated parameters for the initialization function/i,
]

for (const tier of TIERS) {
  test(`renders at the ${tier} quality tier`, async ({ page }) => {
    test.setTimeout(180_000)

    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      if (!BENIGN.some((p) => p.test(text))) errors.push(text)
    })
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

    // `mind=off` for the same reason APP_URL carries it: a refused WebSocket
    // logs a console error from Chromium's network stack, which no JavaScript
    // can suppress, and this test asserts there are none. The link's behaviour
    // without the mind is tested in mind.spec.ts.
    await page.goto(`/?quality=${tier}&capture=1&mind=off`)
    await page.waitForSelector('[data-testid="os-ready"]', {
      state: 'attached',
      timeout: 120_000,
    })

    // The high tier's chain is heavy enough in software that it needs a while
    // to produce a complete frame.
    await page.waitForTimeout(tier === 'high' ? 20_000 : 8000)

    // The tier must be honoured, not silently replaced by device probing — and
    // not quietly demoted by the governor either. `?quality=` is the one tool
    // for inspecting a specific tier, so it standing down is load-bearing.
    //
    // The arrow check is not decoration. A demoted tier renders as "LOW ↓ HIGH",
    // which CONTAINS "HIGH" — so a containment assertion alone would pass while
    // the thing it exists to catch was happening. Under software rasterisation
    // fps sits near 2, far below the downgrade threshold, which makes this a
    // real test of `pinned` rather than a formality.
    const status = page.getByTestId('hud-status')
    await expect(status).toContainText(tier.toUpperCase())
    await expect(status, 'a pinned tier must never be moved').not.toContainText('↓')

    const paint = await samplePaint(page)
    expect(paint.paintedRatio, `${tier} tier renders an empty frame`).toBeGreaterThan(0.05)

    // A shader that fails to compile logs an error and leaves its pass inert —
    // which is exactly the failure a screenshot alone would miss.
    expect(errors, `${tier} tier console errors:\n${errors.join('\n')}`).toEqual([])

    // And the frame has to be legible, not merely present. Depth of field
    // focused 4.6 units in front of the orb passed every other assertion in
    // this file while rendering the avatar at ~93% circle of confusion; the
    // only thing that noticed was a person looking at it.
    const sharp = await sampleSharpness(page)
    expect(
      sharp.p995Step,
      `${tier} tier frame has no fine detail — something is blurring the whole scene ` +
        `(p99.5 ${sharp.p995Step.toFixed(1)}, edges ${sharp.edgeRatio.toFixed(4)}, ` +
        `mean ${sharp.meanStep.toFixed(2)}, max ${sharp.maxStep.toFixed(0)})`,
    ).toBeGreaterThan(SHARPNESS_FLOOR)
  })
}
