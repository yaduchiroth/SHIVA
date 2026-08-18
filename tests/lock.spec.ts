import { expect, test } from '@playwright/test'
import { ESCAPE_MS } from '@/auth/LockScreen'

/**
 * The lock screen.
 *
 * It is a greeting, not a vault — this runs on your own Mac behind your own
 * login — and every test here is about the ways out. A lock screen that can
 * strand you is worse than no lock screen at all, and each of these failures is
 * one a real machine produces: the mind not running, the camera refusing to
 * open, a face the mind does not know.
 */

test.describe('the ways out', () => {
  test('opens immediately when the mind is not running', async ({ page }) => {
    // Nothing could ever recognise you, so waiting is not caution — it is a
    // broken app. This is the case on every machine that is not the desk.
    await page.goto('/?quality=low&capture=1&dev=1&mind=off')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await expect(page.getByTestId('lock-screen')).toHaveCount(0)
  })

  test('a recognised face is greeted and let in', async ({ page }) => {
    await page.goto('/?quality=low&capture=1&dev=1&mind=off&lock=1')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await page.waitForFunction(() => Boolean(window.__shiva), null, { timeout: 30_000 })
    await expect(page.getByTestId('lock-screen')).toBeVisible()

    await page.evaluate(() => window.__shiva!.mind({ kind: 'presence', name: 'Boss', known: true }))
    await expect(page.getByTestId('lock-greeting')).toContainText('Boss')
    await expect(page.getByTestId('lock-screen')).toHaveCount(0, { timeout: 10_000 })
  })

  test('an unrecognised face is told so, and stays out', async ({ page }) => {
    await page.goto('/?quality=low&capture=1&dev=1&mind=off&lock=1')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await page.waitForFunction(() => Boolean(window.__shiva), null, { timeout: 30_000 })

    await page.evaluate(() =>
      window.__shiva!.mind({ kind: 'presence', name: 'Guest', known: false }),
    )
    await expect(page.getByTestId('lock-screen')).toHaveAttribute('data-stage', 'unknown')
  })

  test('a way through appears even when nothing ever happens', async ({ page }) => {
    // The last resort. Whatever has gone wrong — a camera macOS refused, a
    // mind that linked and then wedged — this must never be the reason you
    // cannot reach your own interface.
    test.setTimeout(ESCAPE_MS + 120_000)
    await page.goto('/?quality=low&capture=1&dev=1&mind=off&lock=1')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await expect(page.getByTestId('lock-continue')).toBeVisible({ timeout: ESCAPE_MS + 10_000 })
    await page.getByTestId('lock-continue').click()
    await expect(page.getByTestId('lock-screen')).toHaveCount(0)
  })

  test('a reload inside the same tab does not repeat the ceremony', async ({ page }) => {
    // You are demonstrably still there. A fresh tab greets you again, which is
    // the part worth having; a reload should not.
    await page.goto('/?quality=low&capture=1&dev=1&mind=off&lock=1')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await page.waitForFunction(() => Boolean(window.__shiva), null, { timeout: 30_000 })
    await page.evaluate(() => window.__shiva!.mind({ kind: 'presence', name: 'Boss', known: true }))
    await expect(page.getByTestId('lock-screen')).toHaveCount(0, { timeout: 10_000 })

    await page.reload()
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await expect(page.getByTestId('lock-screen')).toHaveCount(0)
  })
})
