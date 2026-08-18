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
    const escape = page.getByTestId('lock-continue')
    await expect(escape).toBeVisible({ timeout: ESCAPE_MS + 10_000 })

    // Raw mouse input rather than `locator.click()`, and the reason is the fix
    // itself: the lock now opens on the pointerdown, so the button unmounts
    // before the click completes. Playwright's actionability loop then retries
    // against an element that is gone and reports `<html> intercepts pointer
    // events` — which reads exactly like the interception bug this file exists
    // to catch. What matters is the outcome, so press the pixels and check it.
    const box = await escape.boundingBox()
    if (!box) throw new Error('the escape button has no box')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(page.getByTestId('lock-screen')).toHaveCount(0)
  })

  test('the interface underneath stays clickable while the lock is up', async ({ page }) => {
    // The bug this exists for: the overlay was `fixed inset-0 z-50` with no
    // pointer-events rule, so it swallowed every click across the whole
    // viewport. The interface looked perfectly alive and could not be touched —
    // not Enable tracking, not Live, not the text input — until the escape
    // button appeared. Reported as "unresponsive throughout", which is exactly
    // what it was.
    //
    // Nothing in the suite could see it, because every other spec runs with
    // ?mind=off and unlocks before the first assertion.
    await page.goto('/?quality=low&capture=1&dev=1&lock=1')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await expect(page.getByTestId('lock-screen')).toBeVisible()

    // Playwright refuses to click through an intercepting element, so this
    // fails loudly rather than silently passing if the sheet comes back.
    const enable = page.getByRole('button', { name: 'Enable hand tracking' })
    await expect(enable).toBeVisible()
    await enable.click({ timeout: 10_000 })
  })

  test('any deliberate interaction opens it', async ({ page }) => {
    // Someone reaching for a control has answered the only question this screen
    // asks — whether a person is there — more directly than a camera could.
    await page.goto('/?quality=low&capture=1&dev=1&lock=1')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await expect(page.getByTestId('lock-screen')).toBeVisible()
    await page.keyboard.press('Escape')
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
