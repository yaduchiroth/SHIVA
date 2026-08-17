import { expect, test } from '@playwright/test'
import { APP_URL, bootApp, samplePaint } from './helpers'

/**
 * The renderer actually renders.
 *
 * The failure mode this guards against is specific and common in WebGL apps:
 * everything mounts, no errors are thrown, and the canvas is a black rectangle
 * because a shader failed to compile or a material silently fell back. Asserting
 * on the DOM alone sails straight through all of that — so these tests read
 * pixels back off the canvas.
 */

/** Console noise that doesn't indicate a real fault. */
const BENIGN = [
  /Download the React DevTools/i,
  /WebGL.*performance caveat/i,
  /SwiftShader/i,
  /GPU stall/i,
  /THREE\.Clock: This module has been deprecated/i,
  /using deprecated parameters for the initialization function/i,
]

test.describe('render', () => {
  test('boots, paints a real scene, and keeps its GL context', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      if (!BENIGN.some((p) => p.test(text))) errors.push(text)
    })
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

    await bootApp(page)
    await expect(page.locator('canvas')).toBeVisible()

    // Let several frames accumulate. Generous because software rasterisation
    // takes seconds per frame; on real hardware this is instant.
    await page.waitForTimeout(6000)

    const contextOk = await page.evaluate(() => {
      const el = document.querySelector('canvas') as HTMLCanvasElement | null
      if (!el) return 'no canvas'
      const gl = el.getContext('webgl2') ?? el.getContext('webgl')
      if (!gl) return 'no webgl context'
      if (gl.isContextLost()) return 'context lost'
      return 'ok'
    })
    expect(contextOk).toBe('ok')

    const paint = await samplePaint(page)
    expect(paint.width).toBeGreaterThan(0)
    expect(paint.height).toBeGreaterThan(0)

    // A grid, fog, particles and six lit panels cover a substantial share of the
    // frame. An empty canvas scores ~0 against the clear colour.
    expect(paint.paintedRatio, 'canvas is empty — check shader compilation').toBeGreaterThan(0.05)

    // Gradients, fog and bloom produce many distinct values; a flat fill or a
    // single untextured quad would produce very few.
    expect(paint.distinctColors, 'scene looks flat').toBeGreaterThan(8)

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([])
  })

  test('HUD reports system state', async ({ page }) => {
    await bootApp(page)

    await expect(page.getByTestId('hud-status')).toBeVisible()
    await expect(page.getByTestId('hud-clock')).toBeVisible()
    await expect(page.getByTestId('hud-tracking')).toBeVisible()

    // A real time, not a placeholder.
    await expect(page.getByTestId('hud-clock')).toContainText(/\d{2}:\d{2}:\d{2}/)

    // The pinned tier must be reflected, proving `?quality=` is honoured.
    await expect(page.getByTestId('hud-status')).toContainText('LOW')

    // Without a camera grant, the OS must still be driveable by pointer.
    await expect(page.getByTestId('hud-status')).toContainText('Pointer')
  })

  test('carousel steps and wraps consistently', async ({ page }) => {
    await bootApp(page)

    const active = page.getByTestId('active-module')
    const before = await active.textContent()

    await page.keyboard.press('ArrowRight')
    await expect(active).not.toHaveText(before ?? '', { timeout: 15_000 })

    // A full lap returns to the starting module, proving index wrapping agrees
    // between the store and the renderer.
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(250)
    }
    await expect(active).toHaveText(before ?? '', { timeout: 15_000 })
  })

  test('focus opens and dismisses without losing carousel position', async ({ page }) => {
    await bootApp(page)

    const active = page.getByTestId('active-module')
    const start = await active.textContent()

    await page.keyboard.press('Enter')
    await page.waitForTimeout(600)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)

    // Focusing a panel must not advance the ring — a common bug when focus and
    // rotation share an index.
    await expect(active).toHaveText(start ?? '')
  })

  test('degrades honestly when the camera is unavailable', async ({ browser }) => {
    // A context with camera permission explicitly denied: the most common real
    // first-run state, and the one where a spatial UI is most likely to be
    // silently broken.
    const context = await browser.newContext({ permissions: [] })
    const page = await context.newPage()

    await page.goto(APP_URL)
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })

    // The offer to enable tracking is present rather than assumed-on.
    const enable = page.getByRole('button', { name: /enable hand tracking/i })
    await expect(enable).toBeVisible()

    // And the interface is fully usable meanwhile.
    const active = page.getByTestId('active-module')
    const before = await active.textContent()
    await page.keyboard.press('ArrowRight')
    await expect(active).not.toHaveText(before ?? '', { timeout: 15_000 })

    await context.close()
  })
})
