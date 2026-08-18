import { expect, test } from '@playwright/test'
import { mulberry32, spherePoint } from '@/lib/rng'
import {
  buildGlyphs,
  buildNeurons,
  buildProtons,
  buildShell,
  type ShellSpec,
} from '@/spatial/orb/geometry'
import { QUALITY } from '@/core/config/quality'
import { MAX_PULSES, firePulse, orbDrive, resetOrbDrive } from '@/spatial/orb/orbDrive'
import { GLYPHS, COLUMNS } from '@/spatial/orb/glyphAtlas'

/**
 * The orb's arithmetic.
 *
 * None of the visual result can be judged here — CI rasterises in software at
 * about two frames a second — so what is tested is the part that decides
 * whether it will be correct AND affordable: the buffers. The whole design
 * rests on one claim, that each layer is a single draw call, and that claim is
 * really a claim about these arrays being the right size and shape.
 */

const shell = (over: Partial<ShellSpec> = {}): ShellSpec => ({
  radius: 2,
  rings: 8,
  meridians: 12,
  segments: 16,
  crossBands: 4,
  crossLines: 6,
  equatorLines: 6,
  arcs: 6,
  bright: [1, 1, 1],
  mid: [0.5, 0.6, 0.8],
  faint: [0.2, 0.2, 0.25],
  seed: 1,
  ...over,
})

test.describe('determinism', () => {
  // Every layer is seeded rather than using Math.random, so the object is the
  // same on every load. Without this a visual regression cannot be attributed
  // to the change that caused it — only to that run's dice.
  test('the same seed builds byte-identical geometry', () => {
    const a = buildNeurons({ count: 60, synapses: 90, innerRadius: 1, outerRadius: 2, seed: 7 })
    const b = buildNeurons({ count: 60, synapses: 90, innerRadius: 1, outerRadius: 2, seed: 7 })
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    expect(Array.from(a.edgePositions)).toEqual(Array.from(b.edgePositions))
  })

  test('a different seed builds different geometry', () => {
    const a = buildNeurons({ count: 60, synapses: 90, innerRadius: 1, outerRadius: 2, seed: 7 })
    const b = buildNeurons({ count: 60, synapses: 90, innerRadius: 1, outerRadius: 2, seed: 8 })
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions))
  })

  test('sphere points are area-uniform, not latitude-uniform', () => {
    // Drawing phi uniformly is the obvious mistake and it bunches points at the
    // poles, which is glaringly visible on a shell of a few hundred nodes. With
    // the correction, the fraction of points in the polar caps should match the
    // fraction of surface area those caps cover — a third for |cos| > 2/3.
    const rng = mulberry32(3)
    let polar = 0
    const N = 4000
    for (let i = 0; i < N; i++) {
      const [phi] = spherePoint(rng)
      if (Math.abs(Math.cos(phi)) > 2 / 3) polar++
    }
    expect(polar / N).toBeGreaterThan(0.29)
    expect(polar / N).toBeLessThan(0.38)
  })
})

test.describe('the neural network', () => {
  test('nodes land between the requested radii', () => {
    const n = buildNeurons({
      count: 400,
      synapses: 600,
      innerRadius: 0.75,
      outerRadius: 1.75,
      seed: 2,
    })
    for (let i = 0; i < 400; i++) {
      const r = Math.hypot(n.positions[i * 3]!, n.positions[i * 3 + 1]!, n.positions[i * 3 + 2]!)
      expect(r).toBeGreaterThanOrEqual(0.74)
      expect(r).toBeLessThanOrEqual(1.76)
    }
  })

  test('every node is connected to something', () => {
    // An unwired node renders as a dot with no context, which reads as a
    // rendering fault rather than as a quiet neuron. The builder guarantees
    // each node its single nearest neighbour before spending the rest of the
    // budget, so this must hold even when the synapse budget is tight.
    const count = 120
    const n = buildNeurons({ count, synapses: count, innerRadius: 1, outerRadius: 2, seed: 5 })
    const seen = new Set<string>()
    for (let e = 0; e < n.edgeCount; e++) {
      for (const v of [0, 3]) {
        seen.add(
          [
            n.edgePositions[e * 6 + v]!,
            n.edgePositions[e * 6 + v + 1]!,
            n.edgePositions[e * 6 + v + 2]!,
          ].join(),
        )
      }
    }
    expect(seen.size).toBe(count)
  })

  test('edges never exceed the synapse budget', () => {
    const n = buildNeurons({ count: 300, synapses: 200, innerRadius: 1, outerRadius: 2, seed: 4 })
    // The nearest-neighbour guarantee can push slightly past the budget — it
    // runs before the budget is consulted — but only by connectivity, never by
    // the fill pass, so it can never run away.
    expect(n.edgeCount).toBeLessThanOrEqual(300)
    expect(n.edgeCount).toBeGreaterThanOrEqual(200)
  })

  test('both vertices of an edge share one midpoint', () => {
    // The pulse is sampled at the midpoint so an edge lights as one thing.
    // Per-endpoint sampling makes a passing wavefront appear to bend every line
    // it crosses.
    const n = buildNeurons({ count: 50, synapses: 60, innerRadius: 1, outerRadius: 2, seed: 6 })
    for (let e = 0; e < n.edgeCount; e++) {
      for (let axis = 0; axis < 3; axis++) {
        expect(n.edgeMidpoints[e * 6 + axis]).toBeCloseTo(n.edgeMidpoints[e * 6 + 3 + axis]!, 6)
        expect(n.edgeMidpoints[e * 6 + axis]).toBeCloseTo(
          (n.edgePositions[e * 6 + axis]! + n.edgePositions[e * 6 + 3 + axis]!) / 2,
          6,
        )
      }
    }
  })

  test('a node count of zero produces empty buffers rather than throwing', () => {
    const n = buildNeurons({ count: 0, synapses: 0, innerRadius: 1, outerRadius: 2, seed: 1 })
    expect(n.positions.length).toBe(0)
    expect(n.edgeCount).toBe(0)
  })
})

test.describe('the shell', () => {
  test('positions and colours agree, two vertices per segment', () => {
    const s = buildShell(shell())
    expect(s.positions.length).toBe(s.segmentCount * 6)
    expect(s.colors.length).toBe(s.segmentCount * 6)
  })

  test('every vertex sits on the sphere it was asked for', () => {
    // The outer arcs are built at 1.06x, so the bound is the arc radius.
    const s = buildShell(shell({ radius: 2 }))
    for (let i = 0; i < s.positions.length; i += 3) {
      const r = Math.hypot(s.positions[i]!, s.positions[i + 1]!, s.positions[i + 2]!)
      expect(r).toBeGreaterThan(1.9)
      expect(r).toBeLessThan(2.14)
    }
  })

  test('opacity is folded into colour, so nothing exceeds full brightness', () => {
    // Additive blending has no alpha, so brightness IS opacity. A value above 1
    // would both blow out under bloom and, with tone mapping bypassed, shift
    // gold — the exact failure this scene already hit once with an HDR light.
    const s = buildShell(shell())
    for (const c of s.colors) {
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(1)
    }
  })

  test('a single cross line does not divide by zero', () => {
    // crossLines of 1 makes the falloff denominator (n - 1) zero.
    const s = buildShell(shell({ crossLines: 1, equatorLines: 1 }))
    for (const v of s.positions) expect(Number.isFinite(v)).toBe(true)
    for (const c of s.colors) expect(Number.isFinite(c)).toBe(true)
  })
})

test.describe('protons and glyphs', () => {
  test('proton buffers are all the same instance count', () => {
    const p = buildProtons({
      count: 128,
      minRadius: 2.4,
      maxRadius: 3.8,
      hot: [1, 1, 1],
      warm: [0.5, 0.6, 1],
      seed: 9,
    })
    expect(p.orbits.length).toBe(128 * 3)
    expect(p.tilts.length).toBe(128 * 2)
    expect(p.scales.length).toBe(128)
    expect(p.colors.length).toBe(128 * 3)
    expect(p.spins.length).toBe(128)
  })

  test('proton orbits stay inside the carousel ring', () => {
    // Panels sit at radius 4.6. A particle drifting through a panel face is the
    // one artefact that would give away that these are separate systems.
    const p = buildProtons({
      count: 256,
      minRadius: 2.4,
      maxRadius: 3.8,
      hot: [1, 1, 1],
      warm: [1, 1, 1],
      seed: 10,
    })
    for (let i = 0; i < 256; i++) {
      expect(p.orbits[i * 3]!).toBeGreaterThanOrEqual(2.4)
      // The shader adds up to 0.2 of vertical wobble on top of the orbit radius.
      expect(p.orbits[i * 3]! + 0.2).toBeLessThan(4.6)
    }
  })

  test('both orbit directions are represented', () => {
    // Everything turning the same way reads as one rotating object; opposing
    // directions are what make it read as many independent ones.
    const p = buildProtons({
      count: 200,
      minRadius: 2,
      maxRadius: 3,
      hot: [1, 1, 1],
      warm: [1, 1, 1],
      seed: 11,
    })
    const speeds = Array.from({ length: 200 }, (_, i) => p.orbits[i * 3 + 1]!)
    expect(speeds.some((s) => s > 0)).toBe(true)
    expect(speeds.some((s) => s < 0)).toBe(true)
  })

  test('glyph cell indices stay inside the atlas', () => {
    const cells = COLUMNS * Math.ceil(GLYPHS.length / COLUMNS)
    const g = buildGlyphs({ count: 500, cells, innerRadius: 1, outerRadius: 2.2, seed: 12 })
    for (const c of g.cells) {
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThan(cells)
      expect(Number.isInteger(c)).toBe(true)
    }
  })

  test('a glyph budget of zero produces nothing rather than throwing', () => {
    const g = buildGlyphs({ count: 0, cells: 48, innerRadius: 1, outerRadius: 2, seed: 1 })
    expect(g.orbits.length).toBe(0)
  })
})

test.describe('quality budgets', () => {
  test('every tier is thinner than the one above it', () => {
    // The governor's whole downgrade path depends on this ordering. If a tier
    // were not cheaper than its predecessor, demoting a struggling machine
    // would make it slower.
    const keys = ['neurons', 'synapses', 'protons', 'glyphs', 'shellRings'] as const
    for (const k of keys) {
      expect(QUALITY.low.orb[k]).toBeLessThanOrEqual(QUALITY.medium.orb[k])
      expect(QUALITY.medium.orb[k]).toBeLessThanOrEqual(QUALITY.high.orb[k])
    }
  })

  test('the low tier drops the glyph layer entirely', () => {
    // It is the most expensive layer per unit of legibility, and at low-tier
    // pixel ratios the text is sub-pixel anyway.
    expect(QUALITY.low.orb.glyphs).toBe(0)
  })
})

test.describe('the pulse ring buffer', () => {
  test.afterEach(() => resetOrbDrive())

  test('a pulse records its origin and the time it fired', () => {
    orbDrive.time = 4.5
    firePulse(1, 2, 3)
    expect(Array.from(orbDrive.pulseOrigins.slice(0, 3))).toEqual([1, 2, 3])
    expect(orbDrive.pulseTimes[0]).toBe(4.5)
  })

  test('the oldest pulse is overwritten rather than the newest dropped', () => {
    // Rapid input should degrade by losing history, not by ignoring what just
    // happened — a hand that pinches five times fast must still light the orb
    // on the fifth.
    for (let i = 0; i < MAX_PULSES + 1; i++) {
      orbDrive.time = i
      firePulse(i, 0, 0)
    }
    expect(orbDrive.pulseOrigins[0]).toBe(MAX_PULSES)
    expect(orbDrive.pulseTimes[0]).toBe(MAX_PULSES)
  })

  test('a fresh drive has no pulses in flight', () => {
    firePulse(1, 1, 1)
    resetOrbDrive()
    for (const t of orbDrive.pulseTimes) expect(t).toBeLessThan(-1)
  })
})

/**
 * The shaders compile.
 *
 * Five of the orb's layers are hand-written GLSL, and a GLSL error does not
 * throw — three logs it and the material silently renders nothing. So the layer
 * vanishes, the scene still paints, every DOM assertion still passes, and the
 * only symptom is that the orb is missing pieces nobody notices until they look
 * at it on real hardware.
 *
 * `quality=medium` is deliberate: the default test URL pins `low`, which drops
 * the glyph layer entirely and would therefore never compile the most involved
 * shader of the five.
 */
test.describe('shader compilation', () => {
  test('every orb layer compiles at a tier that has all of them', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      const text = msg.text()
      // three reports a failed shader as a console ERROR containing the
      // compiler's own log, so matching on the wording is what makes this
      // specific rather than a general "no errors" assertion.
      if (/shader|glsl|program|uniform|attribute/i.test(text) && msg.type() === 'error') {
        errors.push(text)
      }
    })
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

    await page.goto('/?quality=medium&capture=1')
    await page.waitForSelector('[data-testid="os-ready"]', { state: 'attached', timeout: 90_000 })
    // Software rasterisation takes seconds per frame; a shader is only compiled
    // when its material is first drawn, so the wait has to cover a real frame.
    await page.waitForTimeout(8000)

    expect(errors).toEqual([])
  })
})
