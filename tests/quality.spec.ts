import { expect, test } from '@playwright/test'
import { samplePaint } from './helpers'

/**
 * Every quality tier renders.
 *
 * Tiers mount genuinely different effect chains — the high tier adds god rays,
 * depth of field and chromatic aberration, each of which can fail to compile
 * independently. Without this, a tier nobody develops on can break and stay
 * broken until it reaches someone whose GPU happens to select it.
 *
 * Slow under software rasterisation, so the generous timeout is deliberate.
 */

const TIERS = ['low', 'medium', 'high'] as const

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

    // `odin=off` for the same reason APP_URL carries it: a refused WebSocket
    // logs a console error from Chromium's network stack, which no JavaScript
    // can suppress, and this test asserts there are none. The link's behaviour
    // without Odin is tested in odin.spec.ts.
    await page.goto(`/?quality=${tier}&capture=1&odin=off`)
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
  })
}
