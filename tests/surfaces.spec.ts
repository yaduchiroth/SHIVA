import { expect, test } from '@playwright/test'
import {
  SURFACE_H,
  SURFACE_PX,
  SURFACE_SCALE,
  SURFACE_W,
  WALL,
  rowsFor,
  slotTransform,
  surfaceHalfAngle,
  wallFitsFrustum,
} from '@/spatial/surfaces/layout'
import { CAMERA_BASE, MIN_ASPECT } from '@/core/config/viewpoint'
import { MAX_SURFACES, resetSurfaces, useSurfaceStore } from '@/core/store/useSurfaceStore'

/**
 * The AR surface wall.
 *
 * Two halves, tested differently. The layout is arithmetic and is checked
 * directly. The pointer bridge is DOM behaviour and is checked against a real
 * page in a real browser — which is the only way to know it works, since its
 * whole job is to make a hand indistinguishable from a mouse to code that was
 * never written with hands in mind.
 */

test.describe('wall layout', () => {
  test('a single surface sits dead ahead', () => {
    // The obvious indexing, i / (count - 1), divides by zero here and puts a
    // lone surface at one end of the wall — the one case every user sees first.
    const { position, rotation } = slotTransform(0, 1)
    expect(position[0]).toBeCloseTo(CAMERA_BASE.x, 6)
    expect(position[1]).toBeCloseTo(CAMERA_BASE.y, 6)
    expect(position[2]).toBeCloseTo(CAMERA_BASE.z - WALL.distance, 6)
    expect(rotation[0]).toBeCloseTo(0, 6)
    expect(rotation[1]).toBeCloseTo(0, 6)
  })

  test('two surfaces are placed symmetrically about the view axis', () => {
    const a = slotTransform(0, 2)
    const b = slotTransform(1, 2)
    expect(a.position[0]! - CAMERA_BASE.x).toBeCloseTo(-(b.position[0]! - CAMERA_BASE.x), 6)
    expect(a.position[2]).toBeCloseTo(b.position[2]!, 6)
  })

  test('every surface is the same distance from the eye', () => {
    // Equal distance is what makes each one the same size on screen. Laid out
    // as an arc around the world's origin instead, the outer ones are nearer
    // the camera and read as larger, which looks like a bug in the layout.
    for (let i = 0; i < 6; i++) {
      const { position } = slotTransform(i, 6)
      const d = Math.hypot(
        position[0] - CAMERA_BASE.x,
        position[1] - CAMERA_BASE.y,
        position[2] - CAMERA_BASE.z,
      )
      expect(d).toBeCloseTo(WALL.distance, 5)
    }
  })

  test('a full wall fits inside the narrowest viewport, whole', () => {
    // This is the assertion the first version of this layout would have failed.
    // Surfaces were correctly positioned on an arc around the origin and sat
    // outside the frustum — present, invisible, and reported by nothing.
    expect(wallFitsFrustum(MAX_SURFACES, MIN_ASPECT)).toBe(true)
  })

  test('one more surface than the cap would not fit', () => {
    // So the cap is a consequence of the geometry rather than a taste
    // judgement that could drift away from it.
    expect(wallFitsFrustum(MAX_SURFACES + 1, MIN_ASPECT)).toBe(false)
  })

  test('surfaces sit in front of the carousel ring', () => {
    // Panels ring the origin at 4.6. A surface inside that is tangled in the
    // instruments rather than in front of them.
    for (let i = 0; i < MAX_SURFACES; i++) {
      const { position } = slotTransform(i, MAX_SURFACES)
      expect(Math.hypot(position[0], position[2])).toBeGreaterThan(4.6)
    }
  })

  test('neighbouring surfaces do not overlap', () => {
    const half = surfaceHalfAngle()
    expect(WALL.yawStep).toBeGreaterThan(half.yaw * 2)
    expect(WALL.pitchStep).toBeGreaterThan(half.pitch * 2)
  })

  test('a second row pushes the first down rather than shifting the array up', () => {
    const oneRow = slotTransform(0, 3)
    const twoRows = slotTransform(0, WALL.perRow + 1)
    expect(rowsFor(WALL.perRow + 1)).toBe(2)
    expect(twoRows.position[1]).toBeGreaterThan(oneRow.position[1]!)
  })

  test('a short final row is centred, not left-aligned', () => {
    // Spacing the last row as though it were full would leave it hanging off
    // to one side under the rest.
    const only = slotTransform(WALL.perRow, WALL.perRow + 1)
    expect(only.position[0]).toBeCloseTo(CAMERA_BASE.x, 6)
  })

  test('a surface above the eye line tips down toward the viewer', () => {
    const upper = slotTransform(0, WALL.perRow + 1)
    expect(upper.position[1]).toBeGreaterThan(CAMERA_BASE.y)
    // Negative X rotation pitches the top away and the bottom toward the eye.
    expect(upper.rotation[0]).toBeLessThan(0)
  })

  test('the WebGL frame and the DOM inside it are the same size', () => {
    // Derived rather than typed in. A hand-tuned scale disagrees with the frame
    // drawn around it, and the mismatch is the tell that these are two
    // rendering systems rather than one object.
    expect((SURFACE_PX.width * SURFACE_SCALE) / 40).toBeCloseTo(SURFACE_W, 6)
    expect((SURFACE_PX.height * SURFACE_SCALE) / 40).toBeCloseTo(SURFACE_H, 6)
  })
})

test.describe('the surface store', () => {
  test.beforeEach(() => resetSurfaces())

  test('pushing by the same id replaces in place rather than appending', () => {
    // A repeatedly-refreshed chart must stay in its slot; appending would march
    // it across the wall and evict its neighbours one refresh at a time.
    const store = useSurfaceStore.getState()
    store.push({ kind: 'card', title: 'a', body: '1' }, 'k')
    store.push({ kind: 'card', title: 'a', body: '2' }, 'k')
    const { surfaces } = useSurfaceStore.getState()
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]!.content).toMatchObject({ body: '2' })
  })

  test('an update does not reset the arrival time', () => {
    // `at` drives eviction. Refreshing it would let one busy surface starve
    // every other one out of the room.
    const store = useSurfaceStore.getState()
    store.push({ kind: 'card', title: 'a', body: '1' }, 'k')
    const first = useSurfaceStore.getState().surfaces[0]!.at
    store.push({ kind: 'card', title: 'a', body: '2' }, 'k')
    expect(useSurfaceStore.getState().surfaces[0]!.at).toBe(first)
  })

  test('the oldest surface is evicted past the cap', () => {
    const store = useSurfaceStore.getState()
    for (let i = 0; i < MAX_SURFACES + 3; i++) {
      store.push({ kind: 'card', title: `t${i}`, body: '' }, `k${i}`)
    }
    const { surfaces } = useSurfaceStore.getState()
    expect(surfaces).toHaveLength(MAX_SURFACES)
    expect(surfaces[0]!.id).toBe('k3')
  })

  test('removing the focused surface clears focus', () => {
    // Otherwise focus points at an id that no longer exists, and the next
    // surface to reuse it inherits a focus nobody asked for.
    const store = useSurfaceStore.getState()
    store.push({ kind: 'card', title: 'a', body: '' }, 'k')
    store.focus('k')
    useSurfaceStore.getState().remove('k')
    expect(useSurfaceStore.getState().focused).toBeNull()
  })
})

/**
 * The hand, driving real DOM.
 *
 * This is the part that cannot be reasoned about — it either works against a
 * browser or it does not. Every assertion below goes through the whole chain:
 * hand frame → world projection → screen coordinates → `elementFromPoint` →
 * synthetic event → React handler. Unit-testing the bridge alone would skip the
 * projection, which is exactly where a hand ends up pressing the wrong thing.
 */
test.describe('the hand pointer bridge', () => {
  const DEMO = '/?quality=low&capture=1&surfaces=demo&dev=1'

  test.beforeEach(async ({ page }) => {
    await page.goto(DEMO)
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await page.waitForFunction(() => Boolean(window.__shiva), null, { timeout: 30_000 })
  })

  test('the demo seeds one surface of every kind', async ({ page }) => {
    const kinds = await page.evaluate(() => window.__shiva!.surfaces.list().map((s) => s.kind))
    expect(new Set(kinds)).toEqual(new Set(['card', 'chart', 'report', 'web']))
  })

  test('a hand over an element marks it hovered', async ({ page }) => {
    // CSS :hover cannot be triggered synthetically at all — it is driven by the
    // real cursor and nothing else. The attribute is the substitute, and if it
    // stopped being set, every hover affordance in the interface would go dead
    // for hands with no error anywhere.
    const marked = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="surface-close"]') as HTMLElement
      const box = button.getBoundingClientRect()
      window.__shiva!.pointer(box.left + box.width / 2, box.top + box.height / 2, false)
      return button.hasAttribute('data-hand-hover')
    })
    expect(marked).toBe(true)
  })

  test('a pinch on a button activates it', async ({ page }) => {
    const before = await page.evaluate(() => window.__shiva!.surfaces.list().length)
    await page.evaluate(() => {
      const button = document.querySelector(
        '[data-surface-id="demo-card"] [data-testid="surface-close"]',
      ) as HTMLElement
      const box = button.getBoundingClientRect()
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      window.__shiva!.pointer(x, y, false)
      window.__shiva!.pointer(x, y, true)
      window.__shiva!.pointer(x, y, false)
    })
    await expect
      .poll(() => page.evaluate(() => window.__shiva!.surfaces.list().length))
      .toBe(before - 1)
  })

  test('a pinch that travels scrolls instead of clicking', async ({ page }) => {
    // The touch idiom, and the reason for it: a hand held in the air is never
    // still, so a drag that also fired a click would activate something every
    // time the user tried to read further down a report.
    const result = await page.evaluate(async () => {
      const surface = document.querySelector('[data-surface-id="demo-report"]') as HTMLElement
      const scroller = surface.querySelector('.overflow-y-auto') as HTMLElement
      // Force something to scroll: the iframe's own height is opaque to us.
      scroller.style.height = '80px'
      const spacer = document.createElement('div')
      spacer.style.height = '600px'
      spacer.dataset.testid = 'spacer'
      scroller.appendChild(spacer)
      await new Promise((r) => requestAnimationFrame(r))

      const box = scroller.getBoundingClientRect()
      const x = box.left + box.width / 2
      let y = box.top + box.height - 6
      window.__shiva!.pointer(x, y, false)
      window.__shiva!.pointer(x, y, true)
      for (let i = 0; i < 8; i++) {
        y -= 10
        window.__shiva!.pointer(x, y, true)
      }
      const scrolled = scroller.scrollTop
      window.__shiva!.pointer(x, y, false)
      return { scrolled }
    })
    expect(result.scrolled).toBeGreaterThan(0)
  })

  test('a hand leaving the frame releases whatever it was holding', async ({ page }) => {
    // Otherwise the press outlives the hand and the next one to arrive is
    // already holding something it never grabbed.
    const held = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="surface-focus"]') as HTMLElement
      const box = button.getBoundingClientRect()
      window.__shiva!.pointer(box.left + 4, box.top + 4, true)
      const during = window.__shiva!.bridge().down
      window.__shiva!.pointer(null, null, false)
      return { during, after: window.__shiva!.bridge().down }
    })
    expect(held.during).toBe(true)
    expect(held.after).toBe(false)
  })

  test('the WebGL canvas is never a pointer target', async ({ page }) => {
    // Everything in the 3D scene is already driven by the hand frame directly.
    // Feeding it a second synthetic stream would run every gesture twice, and
    // would raycast at the canvas corner besides, because a constructed event
    // has offsetX/offsetY of zero.
    const hovered = await page.evaluate(() => {
      window.__shiva!.pointer(4, 4, false)
      return window.__shiva!.bridge().hovered?.tagName ?? null
    })
    expect(hovered).not.toBe('CANVAS')
  })

  test('a tracked hand reaches the surface it is pointing at', async ({ page }) => {
    // The full chain, with nothing faked in the middle: a hand position in
    // tracking space, projected to world, projected back to screen, resolved to
    // an element. Driving `pointer()` with screen coordinates — as the tests
    // above do — deliberately skips the projection, and the projection is
    // exactly where a hand ends up touching the wrong thing.
    const hit = await page.evaluate(async () => {
      const surface = document.querySelector('[data-surface-id="demo-card"]') as HTMLElement
      const box = surface.getBoundingClientRect()
      const canvas = document.querySelector('canvas') as HTMLCanvasElement
      const rect = canvas.getBoundingClientRect()

      // Invert the tracking-space mapping rather than assuming a slot is at
      // screen centre — with two rows, the centre of the screen is the gap
      // between them. NDC_RANGE is the overscan the cursor projection applies.
      const NDC_RANGE = 1.6
      const ndcX = ((box.left + box.width / 2 - rect.left) / rect.width) * 2 - 1
      const ndcY = 1 - ((box.top + box.height / 2 - rect.top) / rect.height) * 2
      const handX = 0.5 - ndcX / (2 * NDC_RANGE)
      const handY = 0.5 - ndcY / (2 * NDC_RANGE)

      window.__shiva!.hand({ x: handX, y: handY, gesture: 'point' })
      await new Promise((r) => setTimeout(r, 600))
      const el = window.__shiva!.bridge().hovered
      return {
        onSurface: el ? el.closest('[data-surface-id]')?.getAttribute('data-surface-id') : null,
      }
    })
    expect(hit.onSurface).toBe('demo-card')
  })
})

test.describe('report sandboxing', () => {
  test('a report cannot run script in the parent', async ({ page }) => {
    // The report surface renders HTML written by a model that may have just
    // read an attacker-controlled page. `sandbox=""` withholds allow-scripts
    // and allow-same-origin, so the markup renders and the code does not run.
    await page.goto('/?quality=low&capture=1&dev=1')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await page.waitForFunction(() => Boolean(window.__shiva), null, { timeout: 30_000 })

    await page.evaluate(() => {
      window.__shiva!.surfaces.push(
        {
          kind: 'report',
          title: 'hostile',
          html: `<p id="ok">rendered</p><script>window.parent.__pwned = true</script>`,
        },
        'hostile',
      )
    })

    const frame = page.locator('[data-testid="report-frame"]')
    await expect(frame).toHaveCount(1)
    expect(await frame.getAttribute('sandbox')).toBe('')
    await page.waitForTimeout(1500)
    expect(await page.evaluate(() => '__pwned' in window)).toBe(false)
  })
})
