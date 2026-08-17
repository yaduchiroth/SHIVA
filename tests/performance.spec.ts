import { expect, test } from '@playwright/test'
import { bootApp, isSoftwareRenderer, sampleFrames, samplePaint } from './helpers'

/**
 * Frame-budget and stability checks.
 *
 * Split deliberately by what the environment can actually prove:
 *
 *   - **Throughput** (is it fast enough?) is a property of the GPU. On CI there
 *     isn't one — Chromium falls back to SwiftShader at well under 1fps on this
 *     scene — so those assertions skip with a visible reason rather than being
 *     watered down to a threshold so low it would pass on a broken build.
 *   - **Stability** (does it keep running, does it degrade, does it recover?)
 *     holds at any speed and is asserted everywhere. These catch the leaks and
 *     stalls that a screenshot test never would.
 */

test.describe('performance', () => {
  test('sustains its frame rate on real hardware', async ({ page }) => {
    await bootApp(page)
    test.skip(
      await isSoftwareRenderer(page),
      'No GPU: SwiftShader frame rates measure the CI runner, not the app.',
    )

    await page.waitForTimeout(2500)
    const report = await sampleFrames(page, 6000)

    // 60fps is the target; 20ms p95 allows for occasional GC without accepting
    // a sustained miss.
    expect(report.p95, `p95 frame time ${report.p95.toFixed(1)}ms`).toBeLessThan(20)
    expect(report.max, 'a single frame blew the budget badly').toBeLessThan(120)
  })

  test('render loop keeps producing frames', async ({ page }) => {
    await bootApp(page)
    await page.waitForTimeout(2500)

    // Speed-independent: however slow each frame is, the loop must not stop.
    // A frozen rAF chain — the classic symptom of an exception thrown inside
    // useFrame — produces zero.
    const report = await sampleFrames(page, 8000)
    expect(report.frames, 'render loop produced no frames at all').toBeGreaterThan(0)
  })

  test('sustained interaction does not degrade the frame rate', async ({ page }) => {
    await bootApp(page)
    await page.waitForTimeout(2500)

    const early = await sampleFrames(page, 6000)

    // Exercise the allocating paths: stepping the ring, focusing a panel, and
    // the physics body-type transitions that come with them.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(200)
    }
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(2500)

    const late = await sampleFrames(page, 6000)

    // A per-frame leak — an undisposed texture, a growing listener list, a
    // buffer reallocated every frame — shows up as steadily rising frame times.
    // Comparing against the run's own baseline keeps this meaningful on any
    // hardware; 2.5x absorbs software-rasteriser noise without hiding a real
    // regression.
    expect(
      late.p50,
      `frame time degraded from ${early.p50.toFixed(1)}ms to ${late.p50.toFixed(1)}ms`,
    ).toBeLessThan(early.p50 * 2.5)
  })

  test('recovers after the tab is backgrounded', async ({ page, context }) => {
    await bootApp(page)
    await page.waitForTimeout(2000)

    // Backgrounding pauses rAF, so the first frame back carries a huge delta.
    // Every damping call clamps dt for exactly this reason; without that, the
    // camera and panels would teleport on return.
    const other = await context.newPage()
    await other.goto('about:blank')
    await other.waitForTimeout(3000)
    await other.close()

    await page.bringToFront()
    await page.waitForTimeout(4000)

    const report = await sampleFrames(page, 6000)
    expect(report.frames, 'render loop did not resume after backgrounding').toBeGreaterThan(0)

    // Still drawing real content, not a frozen or blanked canvas.
    const paint = await samplePaint(page)
    expect(paint.paintedRatio, 'canvas went empty after backgrounding').toBeGreaterThan(0.05)
  })
})
