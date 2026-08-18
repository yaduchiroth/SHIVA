import { expect, test } from '@playwright/test'
import {
  HEAVY_KINDS,
  NO_REPLAY,
  STICKY,
  lightKinds,
  parseOdinEvent,
  type OdinEvent,
} from '@/adapters/odin/protocol'
import { useOdinStore } from '@/core/store/useOdinStore'

/**
 * The link to Odin.
 *
 * Odin is a Python process on a Mac, and there is neither one nor a Mac in CI.
 * What can be tested without it is everything downstream of the socket, which
 * is where the bugs actually live: a wire format transcribed from another
 * repository, coercions across a boundary from a language with no static types,
 * and the state machine that decides what a companion orb is doing.
 *
 * The parser tests are deliberately unkind. Every payload below is one a real
 * Odin can send — `ok` omitted on success, `values` called `data`, `items`
 * missing entirely when a list is empty — and each one, taken at face value,
 * produces either a crash or a silently empty screen.
 */

const parse = (msg: Record<string, unknown>): OdinEvent => {
  const event = parseOdinEvent(msg)
  if (!event) throw new Error('expected an event')
  return event
}

test.describe('parsing the wire format', () => {
  test('a message with no kind is not an event', () => {
    expect(parseOdinEvent({ ts: 1 })).toBeNull()
    expect(parseOdinEvent(null)).toBeNull()
    expect(parseOdinEvent('roster')).toBeNull()
  })

  test('an unrecognised kind is carried, not dropped', () => {
    // A newer Odin talking to an older SHIVA is the normal state of two
    // repositories, not an error. Dropping the connection over it, or throwing,
    // would make every Odin release a coordinated one.
    const event = parse({ kind: 'quantum_ansible', ts: 1, payload: 42 })
    expect(event.kind).toBe('unknown')
    if (event.kind === 'unknown') {
      expect(event.name).toBe('quantum_ansible')
      expect(event.payload).toMatchObject({ payload: 42 })
    }
  })

  test('an unknown state falls back to idle rather than corrupting the orb', () => {
    const event = parse({ kind: 'state', value: 'contemplating' })
    expect(event).toMatchObject({ kind: 'state', value: 'idle' })
  })

  test('a chart accepts values, data or y for its numbers', () => {
    // Odin normalises these on its side, but it is one missing `or` there and a
    // blank chart here — and a chart that plots nothing looks like no data
    // rather than like a bug.
    const event = parse({
      kind: 'chart',
      title: 'x',
      series: [
        { name: 'a', values: [1, 2] },
        { name: 'b', data: [3, 4] },
        { label: 'c', y: [5, 6] },
      ],
    })
    if (event.kind !== 'chart') throw new Error('wrong kind')
    expect(event.series.map((s) => s.name)).toEqual(['a', 'b', 'c'])
    expect(event.series[2]!.values).toEqual([5, 6])
  })

  test('a chart series with no numbers is dropped, not plotted as zero', () => {
    // An empty series drawn as a flat line at zero reads as a measurement.
    const event = parse({
      kind: 'chart',
      title: 'x',
      series: [
        { name: 'a', values: [] },
        { name: 'b', values: [1] },
      ],
    })
    if (event.kind !== 'chart') throw new Error('wrong kind')
    expect(event.series).toHaveLength(1)
  })

  test('a chart with no series at all parses rather than throwing', () => {
    const event = parse({ kind: 'chart', title: 'x' })
    expect(event).toMatchObject({ kind: 'chart', series: [], labels: [] })
  })

  test('a roster entry missing its orbit still places the companion', () => {
    // Companion files only sometimes specify an orbit; the layout falls back to
    // a golden-angle spread, which needs the fields absent rather than NaN.
    const event = parse({ kind: 'roster', items: [{ slug: 'thor', name: 'Thor', role: 'Ops' }] })
    if (event.kind !== 'roster') throw new Error('wrong kind')
    expect(event.items[0]).toMatchObject({ slug: 'thor', color: '#e8b93c' })
    expect(event.items[0]!.orbit.radius).toBeUndefined()
  })

  test('a dispatch return without an ok field counts as success', () => {
    // Odin only sets `ok` when something went wrong. Defaulting to false would
    // mark every successful errand as failed.
    const event = parse({ kind: 'dispatch_return', id: '1', slug: 'thor' })
    expect(event).toMatchObject({ ok: true })
    expect(parse({ kind: 'dispatch_return', id: '1', slug: 'thor', ok: false })).toMatchObject({
      ok: false,
    })
  })

  test('a webview with no title falls back to its URL', () => {
    const event = parse({ kind: 'webview', url: 'https://example.com' })
    expect(event).toMatchObject({ title: 'https://example.com' })
  })

  test('a device list of the wrong shape yields an empty list, not a crash', () => {
    expect(parse({ kind: 'devices', items: null })).toMatchObject({ items: [] })
    expect(parse({ kind: 'devices', items: ['a string'] })).toMatchObject({ items: [] })
  })
})

test.describe('replay semantics', () => {
  test('the live-only kinds match Odin`s own NO_REPLAY set', () => {
    // Transcribed from odin/bus.py. If these drift, a reconnecting SHIVA draws
    // dispatch beams for errands that finished ten minutes ago.
    for (const kind of ['audio', 'camera', 'screen', 'dispatch', 'companion']) {
      expect(NO_REPLAY.has(kind)).toBe(true)
    }
    expect(NO_REPLAY.has('roster')).toBe(false)
  })

  test('roster and devices are sticky', () => {
    // Without this a reloaded page has no companions: the roster was emitted
    // once at startup and left the replay window long ago.
    expect(STICKY.has('roster')).toBe(true)
    expect(STICKY.has('devices')).toBe(true)
  })

  test('the trimmed whitelist excludes exactly the image feeds', () => {
    const light = lightKinds()
    for (const heavy of HEAVY_KINDS) expect(light).not.toContain(heavy)
    expect(light).toContain('roster')
    expect(light).toContain('report')
  })
})

test.describe('companion state', () => {
  test.beforeEach(() => useOdinStore.getState().reset())

  test('a roster refresh does not stand down a companion mid-errand', () => {
    // Odin re-emits the whole roster whenever a companion file changes. Resetting
    // every orb to dormant would make working companions look idle while they
    // are still out.
    const store = useOdinStore.getState()
    const roster = [{ slug: 'thor', name: 'Thor', role: 'Ops', color: '#fff', orbit: {} }]
    store.setRoster(roster)
    store.dispatch('d1', 'thor', 'check the deploy')
    useOdinStore.getState().setRoster(roster)
    expect(useOdinStore.getState().companions[0]).toMatchObject({
      state: 'working',
      task: 'check the deploy',
    })
  })

  test('a late return from an earlier errand does not end the current one', () => {
    // The same companion can be sent out twice. Matching on the slug alone
    // would let the first errand's return stand down the second.
    const store = useOdinStore.getState()
    store.setRoster([{ slug: 'thor', name: 'Thor', role: 'Ops', color: '#fff', orbit: {} }])
    store.dispatch('d1', 'thor', 'first')
    store.dispatch('d2', 'thor', 'second')
    useOdinStore.getState().returnDispatch('d1', 'thor', true)
    expect(useOdinStore.getState().companions[0]).toMatchObject({
      state: 'working',
      task: 'second',
    })
  })

  test('losing the link stands every companion down', () => {
    // Orbs left spinning at "working" forever read as Odin being busy rather
    // than absent, which is the opposite of the truth.
    const store = useOdinStore.getState()
    store.setRoster([{ slug: 'thor', name: 'Thor', role: 'Ops', color: '#fff', orbit: {} }])
    store.dispatch('d1', 'thor', 'x')
    useOdinStore.getState().clearDispatch()
    expect(useOdinStore.getState().companions[0]).toMatchObject({ state: 'dormant', task: '' })
  })

  test('the log is bounded', () => {
    const store = useOdinStore.getState()
    for (let i = 0; i < 200; i++) store.appendLog(`line ${i}`)
    const log = useOdinStore.getState().log
    expect(log.length).toBeLessThanOrEqual(60)
    expect(log.at(-1)!.text).toBe('line 199')
  })
})

/**
 * Events becoming interface.
 *
 * Driven through `window.__shiva.odin`, which feeds a raw wire message into the
 * same parser and the same handler the socket uses. That is the whole chain
 * apart from the WebSocket itself — which is the one part that genuinely needs
 * a Mac with Odin running on it.
 */
test.describe('an Odin event becomes interface', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?quality=low&capture=1&dev=1&odin=off')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await page.waitForFunction(() => Boolean(window.__shiva), null, { timeout: 30_000 })
  })

  test('a report event puts a sandboxed surface in the room', async ({ page }) => {
    await page.evaluate(() =>
      window.__shiva!.odin({ kind: 'report', title: 'Q3', html: '<h2>Numbers</h2>' }),
    )
    await expect(page.locator('[data-surface-kind="report"]')).toHaveCount(1)
    expect(await page.locator('[data-testid="report-frame"]').getAttribute('sandbox')).toBe('')
  })

  test('several reports accumulate rather than replacing one another', async ({ page }) => {
    // Odin's own HUD had a single big screen and each report replaced the last.
    // Multiple surfaces is the point of the wall.
    await page.evaluate(() => {
      window.__shiva!.odin({ kind: 'report', title: 'one', html: '<p>1</p>' })
      window.__shiva!.odin({ kind: 'report', title: 'two', html: '<p>2</p>' })
      window.__shiva!.odin({ kind: 'chart', title: 'three', series: [{ name: 'a', values: [1] }] })
    })
    await expect(page.locator('[data-testid="surface"]')).toHaveCount(3)
  })

  test('wellclear empties the room', async ({ page }) => {
    await page.evaluate(() => {
      window.__shiva!.odin({ kind: 'card', title: 'a', body: 'b' })
      window.__shiva!.odin({ kind: 'wellclear' })
    })
    await expect(page.locator('[data-testid="surface"]')).toHaveCount(0)
  })

  test('a state event drives the avatar', async ({ page }) => {
    // One source of truth for the orb: whichever brain is answering, the phase
    // the avatar reads comes from the same place. Odin has five states and the
    // orb has four, so `acting` has to land somewhere sensible rather than
    // falling through to idle while Odin is visibly busy.
    const seen = await page.evaluate(() => {
      const out: string[] = []
      for (const value of ['listening', 'thinking', 'acting', 'speaking', 'idle']) {
        window.__shiva!.odin({ kind: 'state', value })
        out.push(window.__shiva!.state().phase)
      }
      return out
    })
    expect(seen).toEqual(['listening', 'thinking', 'thinking', 'speaking', 'idle'])
  })

  test('a roster event puts companions in orbit', async ({ page }) => {
    const ok = await page.evaluate(() =>
      window.__shiva!.odin({
        kind: 'roster',
        items: [
          { slug: 'thor', name: 'Thor', role: 'Operations', color: '#f0b429', orbit: {} },
          { slug: 'freyja', name: 'Freyja', role: 'Research', color: '#4ade9a', orbit: {} },
        ],
      }),
    )
    expect(ok).toBe(true)
    // Companions live in the WebGL scene, so the DOM cannot see them. The HUD
    // counting them is the visible half; the store is the rest.
    await expect(page.getByTestId('hud-status')).toContainText('Council')
    expect(await page.evaluate(() => window.__shiva!.state().companions)).toEqual([
      { slug: 'thor', state: 'dormant' },
      { slug: 'freyja', state: 'dormant' },
    ])
  })

  test('a dispatch lights a companion and its return stands it down', async ({ page }) => {
    // The whole reason the companions are visible: delegation stops being a
    // line in a log and becomes something you watch leave and come back.
    const states = await page.evaluate(() => {
      window.__shiva!.odin({
        kind: 'roster',
        items: [{ slug: 'thor', name: 'Thor', role: 'Ops', color: '#f0b429', orbit: {} }],
      })
      window.__shiva!.odin({ kind: 'dispatch', id: 'd1', slug: 'thor', task: 'check CI' })
      const working = window.__shiva!.state().companions[0]!.state
      window.__shiva!.odin({ kind: 'dispatch_return', id: 'd1', slug: 'thor' })
      return { working, after: window.__shiva!.state().companions[0]!.state }
    })
    expect(states).toEqual({ working: 'working', after: 'done' })
  })

  test('a device list becomes one connectors screen that refreshes in place', async ({ page }) => {
    // Odin re-emits the whole device list whenever anything changes. Appending
    // would stack a fresh copy of the same panel onto the wall every time a
    // lamp went off, and evict everything else within a minute.
    await page.evaluate(() => {
      window.__shiva!.odin({
        kind: 'devices',
        items: [{ name: 'PS5', online: true }, { name: 'Studio Light' }],
      })
      window.__shiva!.odin({ kind: 'devices', items: [{ name: 'PS5', online: false }] })
    })
    await expect(page.locator('[data-surface-kind="connectors"]')).toHaveCount(1)
    await expect(page.getByTestId('connectors').locator('li')).toHaveCount(1)
  })

  test('a device with no reported state is not shown as offline', async ({ page }) => {
    // Odin often knows about a device without knowing whether it is reachable.
    // A red dot there is a false alarm about something that is probably fine.
    await page.evaluate(() =>
      window.__shiva!.odin({ kind: 'devices', items: [{ name: 'Studio Light' }] }),
    )
    await expect(page.getByTestId('connectors').locator('[aria-label="unknown"]')).toHaveCount(1)
  })

  test('camera frames create one surface and never re-enter the store', async ({ page }) => {
    // The pixels deliberately bypass React. What is asserted is the
    // consequence: many frames, one surface, and the image actually updated.
    const result = await page.evaluate(async () => {
      // A 1x1 JPEG, so the payload is real base64 rather than a string the
      // browser will refuse to decode.
      const jpg =
        '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
      for (let i = 0; i < 12; i++) {
        window.__shiva!.odin({ kind: 'camera', jpg, names: i > 6 ? ['Boss'] : [] })
      }
      return window.__shiva!.surfaces.list().filter((s) => s.kind === 'stream').length
    })
    expect(result).toBe(1)

    // Polled rather than waited on: the surface mounts through the R3F tree,
    // and software rasterisation makes a frame take seconds here.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const img = document.querySelector('[data-testid="stream"] img') as HTMLImageElement
            return Boolean(img?.src?.startsWith('data:image/jpeg'))
          }),
        { timeout: 20_000 },
      )
      .toBe(true)
  })

  test('an unrecognised event changes nothing and breaks nothing', async ({ page }) => {
    // A newer Odin talking to an older SHIVA. It is logged rather than ignored,
    // because "Odin did something and nothing happened" is otherwise impossible
    // to diagnose from this side.
    const accepted = await page.evaluate(() =>
      window.__shiva!.odin({ kind: 'sleipnir', hooves: 8 }),
    )
    expect(accepted).toBe(true)
    await expect(page.locator('[data-testid="surface"]')).toHaveCount(0)
  })
})

/**
 * Odin absent.
 *
 * The normal state on any machine that is not the desk, and therefore the state
 * that has to degrade well. The rest of the suite runs with `odin=off`; this is
 * the one place the link is genuinely allowed to fail.
 */
test.describe('when Odin is not running', () => {
  test('the interface boots anyway and says so', async ({ page }) => {
    await page.goto('/?quality=low&capture=1&dev=1')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })

    // Everything that does not need Odin still works.
    await expect(page.locator('canvas')).toBeVisible()
    await expect(page.getByTestId('hud-status')).toContainText('Odin')

    // And the row says something a person can act on, rather than nothing.
    await expect
      .poll(() => page.evaluate(() => window.__shiva!.state().link), { timeout: 30_000 })
      .toMatch(/connecting|unreachable/)
  })

  test('the reconnect loop is bounded rather than endless', async ({ page }) => {
    // Chromium logs a console error for every refused WebSocket, from the
    // network stack, where nothing can suppress it. Unbounded, that is one line
    // every fifteen seconds for as long as the tab is open, which buries
    // anything real. The client gives up after a window and waits to be woken.
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /WebSocket/i.test(msg.text())) errors.push(msg.text())
    })
    await page.goto('/?quality=low&capture=1&dev=1')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    await page.waitForTimeout(20_000)
    // Eight attempts is the cap; anything far above it means the bound is gone.
    expect(errors.length).toBeLessThanOrEqual(8)
  })
})
