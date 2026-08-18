import { expect, test } from '@playwright/test'
import {
  pickTargetScreen,
  windowFeatures,
  type ScreenDetailsLike,
  type ScreenLike,
} from '@/core/screens/placement'
import { DOCK_THRESHOLD } from '@/spatial/surfaces/useSurfaceDrag'
import { MAX_SCALE, MIN_SCALE, resetSurfaces, useSurfaceStore } from '@/core/store/useSurfaceStore'

/**
 * The second display.
 *
 * There is no second monitor in CI and there never will be, so the split is:
 * the arithmetic that decides where a window goes is tested directly, and the
 * handoff between windows is tested with two real pages talking over the same
 * BroadcastChannel — which is the whole mechanism apart from the pixels landing
 * on different glass.
 */

const screen = (over: Partial<ScreenLike> = {}): ScreenLike => ({
  availLeft: 0,
  availTop: 0,
  availWidth: 1512,
  availHeight: 945,
  isPrimary: true,
  label: 'Built-in',
  ...over,
})

test.describe('picking the other display', () => {
  test('returns null when there is only one screen', () => {
    const only = screen()
    expect(pickTargetScreen({ screens: [only], currentScreen: only })).toBeNull()
  })

  test('picks the screen SHIVA is not on, even when that is the primary', () => {
    // The obvious version picks the first non-primary screen, and it is wrong
    // for the person most likely to use this: someone who has already dragged
    // SHIVA onto their external monitor. For them the primary IS the other one,
    // and picking by isPrimary sends every surface back to the window they are
    // looking at.
    const laptop = screen({ label: 'Built-in', isPrimary: true })
    const external = screen({
      label: 'Studio Display',
      isPrimary: false,
      availLeft: 1512,
      availWidth: 2560,
      availHeight: 1440,
    })
    const target = pickTargetScreen({ screens: [laptop, external], currentScreen: external })
    expect(target?.label).toBe('Built-in')
  })

  test('compares screens by geometry, not by reference', () => {
    // currentScreen is a live object and is not guaranteed to be reference
    // identical to its entry in `screens`. Comparing with !== silently treats
    // the current screen as a candidate, and the window opens on top of itself.
    const laptop = screen({ label: 'Built-in' })
    const external = screen({ label: 'External', isPrimary: false, availLeft: 1512 })
    const target = pickTargetScreen({
      screens: [laptop, external],
      currentScreen: { ...laptop },
    })
    expect(target?.label).toBe('External')
  })

  test('with three screens, picks the largest free one', () => {
    const current = screen({ label: 'Built-in' })
    const small = screen({
      label: 'Side',
      isPrimary: false,
      availLeft: 1512,
      availWidth: 1280,
      availHeight: 720,
    })
    const big = screen({
      label: 'Studio',
      isPrimary: false,
      availLeft: 2792,
      availWidth: 2560,
      availHeight: 1440,
    })
    const details: ScreenDetailsLike = { screens: [current, small, big], currentScreen: current }
    expect(pickTargetScreen(details)?.label).toBe('Studio')
  })

  test('the features string fills the target screen', () => {
    const features = windowFeatures(
      screen({ availLeft: 1512, availTop: 25, availWidth: 2560, availHeight: 1415 }),
    )
    expect(features).toContain('left=1512')
    expect(features).toContain('top=25')
    expect(features).toContain('width=2560')
    expect(features).toContain('height=1415')
    // Chrome only honours a position for a genuine popup.
    expect(features).toContain('popup=yes')
  })

  test('fractional screen coordinates are rounded', () => {
    // A fractional value in the features string is ignored outright by Chrome,
    // and a scaled display reports them.
    const features = windowFeatures(screen({ availLeft: 1512.5, availWidth: 2560.4 }))
    expect(features).toContain('left=1513')
    expect(features).not.toMatch(/\d\.\d/)
  })
})

test.describe('surface scale', () => {
  test.beforeEach(() => resetSurfaces())

  test('clamps at both ends', () => {
    // Both limits stop being useful rather than merely looking odd: below half
    // the type is unreadable, above two and a half one surface hides its
    // neighbours entirely.
    const store = useSurfaceStore.getState()
    store.push({ kind: 'card', title: 'a', body: '' }, 'k')
    for (let i = 0; i < 40; i++) useSurfaceStore.getState().scale('k', 1.2)
    expect(useSurfaceStore.getState().surfaces[0]!.scale).toBe(MAX_SCALE)
    for (let i = 0; i < 80; i++) useSurfaceStore.getState().scale('k', 0.8)
    expect(useSurfaceStore.getState().surfaces[0]!.scale).toBe(MIN_SCALE)
  })

  test('an unscaled surface starts at 1', () => {
    const store = useSurfaceStore.getState()
    store.push({ kind: 'card', title: 'a', body: '' }, 'k')
    store.scale('k', 1)
    expect(useSurfaceStore.getState().surfaces[0]!.scale).toBe(1)
  })
})

test.describe('detach and attach', () => {
  test.beforeEach(() => resetSurfaces())

  test('a detached surface leaves whole, and is no longer marked leaving', () => {
    // It is not going away, it is going somewhere else — a `removing` flag
    // would arrive with it and make it fade out on the other display.
    const store = useSurfaceStore.getState()
    store.push({ kind: 'card', title: 'a', body: 'body' }, 'k')
    const taken = useSurfaceStore.getState().detach('k')
    expect(taken).toMatchObject({ id: 'k', removing: false })
    expect(taken!.content).toMatchObject({ body: 'body' })
    expect(useSurfaceStore.getState().surfaces).toHaveLength(0)
  })

  test('detaching releases focus and grab', () => {
    const store = useSurfaceStore.getState()
    store.push({ kind: 'card', title: 'a', body: '' }, 'k')
    store.focus('k')
    store.setGrabbed('k')
    useSurfaceStore.getState().detach('k')
    expect(useSurfaceStore.getState().focused).toBeNull()
    expect(useSurfaceStore.getState().grabbed).toBeNull()
  })

  test('a surface sent across and back does not arrive twice', () => {
    const store = useSurfaceStore.getState()
    store.push({ kind: 'card', title: 'a', body: '' }, 'k')
    const taken = useSurfaceStore.getState().detach('k')!
    useSurfaceStore.getState().attach(taken)
    useSurfaceStore.getState().attach(taken)
    expect(useSurfaceStore.getState().surfaces).toHaveLength(1)
  })

  test('detaching something that is not there is not an error', () => {
    expect(useSurfaceStore.getState().detach('nope')).toBeNull()
  })
})

test.describe('the dock threshold', () => {
  test('sits past the wall but within reach', () => {
    // A fraction rather than pixels, so it means the same on a laptop panel and
    // a 6K display. Too near and you trip it while reading something on the
    // right of the wall; too far and it is a stretch.
    expect(DOCK_THRESHOLD).toBeGreaterThan(0.7)
    expect(DOCK_THRESHOLD).toBeLessThan(0.95)
  })
})

/**
 * Two windows, one channel.
 *
 * The whole mechanism apart from the pixels landing on different glass. Two
 * real pages in one browser context share a BroadcastChannel exactly as two
 * windows on two monitors would, so this exercises the handshake, the handoff
 * and the return without any hardware CI does not have.
 */
test.describe('the handoff between windows', () => {
  test('a surface dragged to the edge arrives on the display', async ({ context }) => {
    const main = await context.newPage()
    await main.goto('/?quality=low&capture=1&dev=1&mind=off&surfaces=demo')
    await main.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await main.waitForFunction(() => Boolean(window.__shiva), null, { timeout: 30_000 })

    const display = await context.newPage()
    await display.goto('/display')
    await expect(display.getByTestId('display-brand')).toBeVisible()

    // The display announces itself and the main window answers, so both learn
    // about each other regardless of which loaded first.
    await expect
      .poll(() => display.locator('[data-testid="display-brand"] ~ span').textContent(), {
        timeout: 20_000,
      })
      .toContain('linked')

    const before = await main.evaluate(() => window.__shiva!.surfaces.list().length)

    // Grab by the header and release past the dock threshold. Driven with real
    // pointer events, which is exactly what the hand bridge dispatches — there
    // is one path here, not a hand path and a mouse path.
    await main.evaluate(async (threshold) => {
      const handle = document.querySelector(
        '[data-surface-id="demo-card"] [data-testid="surface-handle"]',
      ) as HTMLElement
      const box = handle.getBoundingClientRect()
      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: box.left + 30,
          clientY: box.top + 8,
        }),
      )
      const x = window.innerWidth * (threshold + 0.1)
      window.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: 300 }),
      )
      await new Promise((r) => setTimeout(r, 50))
      window.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: 300 }),
      )
    }, DOCK_THRESHOLD)

    await expect(display.locator('[data-surface-id="demo-card"]')).toHaveCount(1, {
      timeout: 15_000,
    })
    await expect
      .poll(() => main.evaluate(() => window.__shiva!.surfaces.list().length))
      .toBe(before - 1)

    // And back again, which is the same mechanism in reverse.
    await display.getByTestId('display-return').first().click()
    await expect
      .poll(() => main.evaluate(() => window.__shiva!.surfaces.list().length), { timeout: 15_000 })
      .toBe(before)

    await display.close()
    await main.close()
  })

  test('a drag released short of the edge keeps the surface', async ({ context }) => {
    // The threshold has to be a real boundary. Without this test, a bug that
    // sent every dragged surface across would look like the feature working.
    const main = await context.newPage()
    await main.goto('/?quality=low&capture=1&dev=1&mind=off&surfaces=demo')
    await main.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await main.waitForFunction(() => Boolean(window.__shiva), null, { timeout: 30_000 })

    const display = await context.newPage()
    await display.goto('/display')
    await expect(display.getByTestId('display-brand')).toBeVisible()
    await main.waitForTimeout(1500)

    const before = await main.evaluate(() => window.__shiva!.surfaces.list().length)
    await main.evaluate(() => {
      const handle = document.querySelector(
        '[data-surface-id="demo-card"] [data-testid="surface-handle"]',
      ) as HTMLElement
      const box = handle.getBoundingClientRect()
      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: box.left + 30,
          clientY: box.top + 8,
        }),
      )
      const x = window.innerWidth * 0.5
      window.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: 300 }),
      )
      window.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: 300 }),
      )
    })

    await main.waitForTimeout(1000)
    expect(await main.evaluate(() => window.__shiva!.surfaces.list().length)).toBe(before)
    await expect(display.locator('[data-testid="display-surface"]')).toHaveCount(0)

    await display.close()
    await main.close()
  })

  test('nothing is sent when no display window is open', async ({ page }) => {
    // Dragging to the edge with nowhere to send it must be a no-op, not a
    // surface that vanishes into a channel nobody is listening on.
    await page.goto('/?quality=low&capture=1&dev=1&mind=off&surfaces=demo')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await page.waitForFunction(() => Boolean(window.__shiva), null, { timeout: 30_000 })

    const before = await page.evaluate(() => window.__shiva!.surfaces.list().length)
    await page.evaluate((threshold) => {
      const handle = document.querySelector(
        '[data-surface-id="demo-card"] [data-testid="surface-handle"]',
      ) as HTMLElement
      const box = handle.getBoundingClientRect()
      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: box.left + 30,
          clientY: box.top + 8,
        }),
      )
      const x = window.innerWidth * (threshold + 0.1)
      window.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: 300 }),
      )
      window.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: 300 }),
      )
    }, DOCK_THRESHOLD)

    await page.waitForTimeout(1000)
    expect(await page.evaluate(() => window.__shiva!.surfaces.list().length)).toBe(before)
  })
})
