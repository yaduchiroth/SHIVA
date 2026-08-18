import { mulberry32, range, spherePoint, type Rng } from '@/lib/rng'

/**
 * Every buffer the orb is built from, computed on the CPU exactly once.
 *
 * Deliberately free of three.js and of the DOM: these are the numbers, not the
 * scene graph. That keeps them testable without a WebGL context — which
 * matters, because the container this is developed in has no GPU and the test
 * suite runs on a software rasteriser at about two frames a second.
 *
 * The organising rule for the whole orb is ONE DRAW CALL PER LAYER. The
 * reference implementation this is derived from builds a `THREE.Line` per ring,
 * a `Mesh` per orbiting rock and a `Sprite` — with its own 256x32 canvas
 * texture — per drifting glyph. At its default counts that is roughly 2,200
 * draw calls and 55 MB of texture for a single object, plus a 1,700-iteration
 * JavaScript loop repositioning sprites on every frame. It looks superb on a
 * fast Mac and would flatten anything else, and it would arrive as "the
 * animation is low quality" rather than as an error.
 *
 * So: rings merge into one `LineSegments`, rocks become one `InstancedMesh`,
 * glyphs become one instanced quad reading a shared atlas, and all of the
 * motion is computed in vertex shaders from `uTime` rather than in JS. Same
 * object, about eleven draw calls, nothing per-frame on the CPU.
 */

/** RGB in 0..1. Alpha is folded into magnitude — see `pushSegment`. */
export type Rgb = readonly [number, number, number]

// ── Shell ────────────────────────────────────────────────────────────────────

export interface ShellSpec {
  radius: number
  /** Latitude rings per hemisphere; the equator is shared, so 2n+1 in total. */
  rings: number
  meridians: number
  /** Subdivisions per ring or meridian. */
  segments: number
  /** Bright wide meridian bands — the "plus" that reads as the orb's face. */
  crossBands: number
  crossLines: number
  /** Lines making up the wide bright equator band. */
  equatorLines: number
  /** Loose partial arcs on a slightly larger radius, for depth. */
  arcs: number
  bright: Rgb
  mid: Rgb
  faint: Rgb
  seed: number
}

export interface LineArrays {
  /** xyz, two vertices per segment. */
  positions: Float32Array
  /**
   * rgb, two vertices per segment.
   *
   * There is no alpha channel because the material is additive, where
   * brightness IS opacity: a colour at a tenth of its magnitude contributes a
   * tenth as much light. Folding opacity into the colour is what lets several
   * hundred lines of a dozen different strengths share one draw call, instead
   * of needing a material — and therefore a call — per strength.
   */
  colors: Float32Array
  segmentCount: number
}

/** Cartesian position on a sphere from latitude (-pi/2..pi/2) and longitude. */
const onSphere = (r: number, lat: number, lon: number): [number, number, number] => [
  r * Math.cos(lat) * Math.cos(lon),
  r * Math.sin(lat),
  r * Math.cos(lat) * Math.sin(lon),
]

/** Accumulates line segments into growable arrays before they are frozen. */
class SegmentSink {
  readonly positions: number[] = []
  readonly colors: number[] = []

  /** `alpha` scales the colour, because additive blending has no alpha. */
  push(a: readonly number[], b: readonly number[], color: Rgb, alpha: number): void {
    this.positions.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!)
    const r = color[0] * alpha
    const g = color[1] * alpha
    const bl = color[2] * alpha
    this.colors.push(r, g, bl, r, g, bl)
  }

  /** Walks a parametric curve, emitting one segment between each pair of samples. */
  curve(
    samples: number,
    at: (t: number) => [number, number, number],
    color: Rgb,
    alpha: number,
  ): void {
    let prev = at(0)
    for (let i = 1; i <= samples; i++) {
      const next = at(i / samples)
      this.push(prev, next, color, alpha)
      prev = next
    }
  }

  freeze(): LineArrays {
    return {
      positions: new Float32Array(this.positions),
      colors: new Float32Array(this.colors),
      segmentCount: this.positions.length / 6,
    }
  }
}

export function buildShell(spec: ShellSpec): LineArrays {
  const { radius: R, segments, bright, mid, faint } = spec
  const rng = mulberry32(spec.seed)
  const sink = new SegmentSink()

  // Latitude rings. Every third one is emphasised, which is what stops a dense
  // grid reading as flat grey noise.
  for (let i = -spec.rings; i <= spec.rings; i++) {
    const lat = (i / spec.rings) * (Math.PI / 2) * 0.95
    const major = i % 3 === 0
    sink.curve(
      segments,
      (t) => onSphere(R, lat, t * Math.PI * 2),
      major ? mid : faint,
      major ? 0.5 : 0.12,
    )
  }

  // Meridians, same trick.
  for (let i = 0; i < spec.meridians; i++) {
    const lon = (i / spec.meridians) * Math.PI * 2
    const major = i % 6 === 0
    sink.curve(
      segments,
      (t) => onSphere(R, t * Math.PI - Math.PI / 2, lon),
      major ? mid : faint,
      major ? 0.6 : 0.1,
    )
  }

  // The bright cross bands: several closely-spaced meridians whose brightness
  // falls off from the centre line, so they read as a band of light rather than
  // as a set of separate lines.
  const CROSS_SPREAD = 0.25
  for (let i = 0; i < spec.crossBands; i++) {
    const lon = (i / spec.crossBands) * Math.PI * 2
    for (let j = 0; j < spec.crossLines; j++) {
      const t = spec.crossLines === 1 ? 0 : (j / (spec.crossLines - 1)) * 2 - 1
      const offset = (t * CROSS_SPREAD) / 2
      const falloff = 1 - Math.abs(t) * 0.7
      sink.curve(
        segments,
        (u) => onSphere(R, u * Math.PI - Math.PI / 2, lon + offset),
        Math.abs(t) < 0.3 ? bright : mid,
        0.85 * falloff,
      )
    }
  }

  // The equator band, built the same way out of latitude rings.
  const EQ_SPREAD = 0.35
  for (let j = 0; j < spec.equatorLines; j++) {
    const t = spec.equatorLines === 1 ? 0 : (j / (spec.equatorLines - 1)) * 2 - 1
    const lat = (t * EQ_SPREAD) / 2
    const falloff = 1 - Math.abs(t) * 0.65
    sink.curve(
      segments,
      (u) => onSphere(R, lat, u * Math.PI * 2),
      Math.abs(t) < 0.3 ? bright : mid,
      0.8 * falloff,
    )
  }

  // A second, slightly larger shell of partial arcs. Incomplete on purpose:
  // closed rings at two radii read as two spheres, whereas broken arcs read as
  // one sphere with detail floating just off its surface.
  const R2 = R * 1.06
  for (let i = 0; i < spec.arcs; i++) {
    const meridianArc = i % 3 === 0
    const start = range(rng, 0, Math.PI * 2)
    const span = range(rng, 0.3, meridianArc ? 1.1 : 1.5)
    if (meridianArc) {
      const lon = range(rng, 0, Math.PI * 2)
      const lat0 = range(rng, -0.4, 0.4) * Math.PI
      sink.curve(24, (t) => onSphere(R2, lat0 + t * span, lon), faint, range(rng, 0.15, 0.35))
    } else {
      const lat = range(rng, -0.42, 0.42) * Math.PI
      sink.curve(40, (t) => onSphere(R2, lat, start + t * span), mid, range(rng, 0.2, 0.5))
    }
  }

  return sink.freeze()
}

// ── Neurons ──────────────────────────────────────────────────────────────────

export interface NeuronSpec {
  count: number
  synapses: number
  /** Nodes sit between these radii, so the network has depth rather than being a skin. */
  innerRadius: number
  outerRadius: number
  seed: number
}

export interface NeuronArrays {
  /** xyz per node — used as instance offsets. */
  positions: Float32Array
  /** Per-node phase, so nodes twinkle out of step. */
  phases: Float32Array
  /** Per-node scale variation. */
  scales: Float32Array
  /** xyz per synapse vertex, two vertices per synapse. */
  edgePositions: Float32Array
  /**
   * The midpoint of each edge, repeated for both of its vertices.
   *
   * A pulse travelling through the network is evaluated per vertex, so an edge
   * lit by its own endpoints would light unevenly and appear to bend. Giving
   * both vertices the same sample point makes each edge light as one thing.
   */
  edgeMidpoints: Float32Array
  edgeCount: number
}

/**
 * Nodes scattered through a shell, wired to their nearest neighbours.
 *
 * Nearest-first wiring is what makes it read as a network. Random pairs produce
 * a ball of string with no local structure, which at a glance is indistinguishable
 * from noise; short edges cluster into visible neighbourhoods that a travelling
 * pulse can move through.
 *
 * Every node is guaranteed its single closest neighbour before the remaining
 * budget is spent on the globally shortest edges, so the graph has no orphans —
 * an unconnected node reads as a rendering bug rather than as a quiet neuron.
 */
export function buildNeurons(spec: NeuronSpec): NeuronArrays {
  const rng: Rng = mulberry32(spec.seed)
  const n = Math.max(0, spec.count)
  const positions = new Float32Array(n * 3)
  const phases = new Float32Array(n)
  const scales = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    const [phi, theta] = spherePoint(rng)
    // Cube-rooted so the shell fills evenly by volume rather than bunching at
    // the inner radius, where a linear draw would put most of the points.
    const t = Math.cbrt(rng())
    const r = spec.innerRadius + (spec.outerRadius - spec.innerRadius) * t
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = r * Math.cos(phi)
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    phases[i] = rng() * Math.PI * 2
    scales[i] = range(rng, 0.6, 1.5)
  }

  const dist2 = (a: number, b: number): number => {
    const dx = positions[a * 3]! - positions[b * 3]!
    const dy = positions[a * 3 + 1]! - positions[b * 3 + 1]!
    const dz = positions[a * 3 + 2]! - positions[b * 3 + 2]!
    return dx * dx + dy * dy + dz * dz
  }

  const key = (a: number, b: number): number => (a < b ? a * n + b : b * n + a)
  const chosen = new Set<number>()
  const edges: [number, number][] = []

  // Only each node's K nearest are ever considered. Keeping every pair would
  // mean n^2 candidate objects and a sort over them — at 600 nodes that is
  // 359,400 allocations to choose 1,200 edges, which is a visible hitch during
  // scene construction and enormous garbage for no better result. Nothing
  // beyond a node's closest handful is ever short enough to be picked.
  const K = 6
  const nearD = new Float64Array(K)
  const nearI = new Int32Array(K)
  const candidates: { a: number; b: number; d: number }[] = []

  for (let i = 0; i < n; i++) {
    nearD.fill(Infinity)
    nearI.fill(-1)
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const d = dist2(i, j)
      if (d >= nearD[K - 1]!) continue
      // Insertion into a K-slot sorted window. K is small enough that this
      // beats anything cleverer, and it allocates nothing.
      let slot = K - 1
      while (slot > 0 && nearD[slot - 1]! > d) {
        nearD[slot] = nearD[slot - 1]!
        nearI[slot] = nearI[slot - 1]!
        slot--
      }
      nearD[slot] = d
      nearI[slot] = j
    }

    // The single closest is guaranteed, so no node is left unconnected — an
    // orphan reads as a rendering bug rather than as a quiet neuron.
    const best = nearI[0]!
    if (best >= 0 && !chosen.has(key(i, best))) {
      chosen.add(key(i, best))
      edges.push([i, best])
    }
    for (let k = 1; k < K; k++) {
      if (nearI[k]! >= 0) candidates.push({ a: i, b: nearI[k]!, d: nearD[k]! })
    }
  }

  // Remaining budget goes to the globally shortest of what is left, so the
  // network thickens where it is already dense instead of growing long struts
  // across the middle.
  candidates.sort((x, y) => x.d - y.d)
  for (const c of candidates) {
    if (edges.length >= spec.synapses) break
    const k = key(c.a, c.b)
    if (chosen.has(k)) continue
    chosen.add(k)
    edges.push([c.a, c.b])
  }

  const edgePositions = new Float32Array(edges.length * 6)
  const edgeMidpoints = new Float32Array(edges.length * 6)
  edges.forEach(([a, b], e) => {
    for (let axis = 0; axis < 3; axis++) {
      const pa = positions[a * 3 + axis]!
      const pb = positions[b * 3 + axis]!
      edgePositions[e * 6 + axis] = pa
      edgePositions[e * 6 + 3 + axis] = pb
      const mid = (pa + pb) / 2
      edgeMidpoints[e * 6 + axis] = mid
      edgeMidpoints[e * 6 + 3 + axis] = mid
    }
  })

  return { positions, phases, scales, edgePositions, edgeMidpoints, edgeCount: edges.length }
}

// ── Protons ──────────────────────────────────────────────────────────────────

export interface ProtonSpec {
  count: number
  minRadius: number
  maxRadius: number
  hot: Rgb
  warm: Rgb
  seed: number
}

export interface ProtonArrays {
  /** [orbitRadius, angularSpeed, phase] per instance. */
  orbits: Float32Array
  /** [tiltX, tiltZ] per instance — the inclination that makes it atomic rather than flat. */
  tilts: Float32Array
  scales: Float32Array
  /** Per-instance rgb, brightness folded in as with the shell. */
  colors: Float32Array
  spins: Float32Array
}

export function buildProtons(spec: ProtonSpec): ProtonArrays {
  const rng = mulberry32(spec.seed)
  const n = Math.max(0, spec.count)
  const orbits = new Float32Array(n * 3)
  const tilts = new Float32Array(n * 2)
  const scales = new Float32Array(n)
  const colors = new Float32Array(n * 3)
  const spins = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    orbits[i * 3] = range(rng, spec.minRadius, spec.maxRadius)
    // Signed, so roughly half the cloud counter-orbits. Everything turning the
    // same way reads as one rotating object; opposing directions read as many
    // independent ones, which is the whole point of the layer.
    orbits[i * 3 + 1] = range(rng, 0.08, 0.68) * (rng() > 0.5 ? 1 : -1)
    orbits[i * 3 + 2] = rng() * Math.PI * 2
    tilts[i * 2] = (rng() - 0.5) * Math.PI * 0.9
    tilts[i * 2 + 1] = (rng() - 0.5) * Math.PI * 0.5
    scales[i] = range(rng, 0.5, 2.2)
    spins[i] = range(rng, 0.4, 1.6)
    const c = rng() > 0.7 ? spec.hot : spec.warm
    const a = range(rng, 0.3, 0.9)
    colors[i * 3] = c[0] * a
    colors[i * 3 + 1] = c[1] * a
    colors[i * 3 + 2] = c[2] * a
  }

  return { orbits, tilts, scales, colors, spins }
}

// ── Glyphs ───────────────────────────────────────────────────────────────────

export interface GlyphSpec {
  count: number
  /** How many cells the atlas holds; cell indices are drawn from this range. */
  cells: number
  innerRadius: number
  outerRadius: number
  seed: number
}

export interface GlyphArrays {
  /** [phi, radius, theta0] per instance — spherical, so drift is one add. */
  orbits: Float32Array
  /** Signed angular drift, radians/sec. */
  speeds: Float32Array
  /** Which atlas cell this instance samples. */
  cells: Float32Array
  /** World-space width; height is derived from the atlas aspect in the shader. */
  sizes: Float32Array
  alphas: Float32Array
}

export function buildGlyphs(spec: GlyphSpec): GlyphArrays {
  const rng = mulberry32(spec.seed)
  const n = Math.max(0, spec.count)
  const orbits = new Float32Array(n * 3)
  const speeds = new Float32Array(n)
  const cells = new Float32Array(n)
  const sizes = new Float32Array(n)
  const alphas = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    const [phi] = spherePoint(rng)
    orbits[i * 3] = phi
    orbits[i * 3 + 1] = range(rng, spec.innerRadius, spec.outerRadius)
    orbits[i * 3 + 2] = rng() * Math.PI * 2
    speeds[i] = range(rng, 0.012, 0.06) * (rng() > 0.5 ? 1 : -1)
    cells[i] = Math.floor(rng() * spec.cells)
    sizes[i] = range(rng, 0.16, 0.34)
    alphas[i] = range(rng, 0.35, 0.9)
  }

  return { orbits, speeds, cells, sizes, alphas }
}
