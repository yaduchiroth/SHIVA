import type { QualityTier } from '@/lib/device'

/**
 * Per-tier render budget.
 *
 * Every expensive feature is expressed here rather than hard-coded in
 * components, so degrading gracefully is a data change rather than a hunt
 * through the scene graph.
 */
/**
 * How much orb there is.
 *
 * Separated from the rest of the tier because the orb is by far the densest
 * object in the scene and its cost is almost entirely a function of these five
 * numbers. Keeping them here means the governor's existing downgrade path
 * thins the orb along with everything else, rather than the orb being the one
 * thing that stays expensive on a machine that has already said it is
 * struggling.
 */
export interface OrbBudget {
  /** Nodes on the neural shell. */
  neurons: number
  /** Edges between them. Roughly 2x neurons reads as a network; 1x reads as a mess. */
  synapses: number
  /** Orbiting particles — the "protons". */
  protons: number
  /** Drifting code glyphs. Zero removes the layer entirely. */
  glyphs: number
  /** Latitude rings per hemisphere on the outer wireframe shell. */
  shellRings: number
  /** Meridians on the outer wireframe shell. */
  shellMeridians: number
}

export interface QualitySettings {
  /** [min, max] device pixel ratio handed to the renderer. */
  dpr: [number, number]
  bloom: boolean
  godRays: boolean
  depthOfField: boolean
  chromaticAberration: boolean
  /** Transmission samples on glass panels — the single most expensive knob. */
  transmissionSamples: number
  transmissionResolution: number
  particleCount: number
  shadows: boolean
  /** Hand-tracking inference ceiling, Hz. Inference competes with rendering. */
  trackingHz: number
  fogDensity: number
  orb: OrbBudget
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  low: {
    dpr: [0.6, 1],
    // Bloom survives even here: it's the last effect worth cutting, because
    // without it nothing glows and the whole aesthetic collapses.
    bloom: true,
    godRays: false,
    depthOfField: false,
    chromaticAberration: false,
    transmissionSamples: 2,
    transmissionResolution: 128,
    particleCount: 600,
    shadows: false,
    trackingHz: 20,
    fogDensity: 0.055,
    // Enough structure to still read as the same object, with the glyph layer
    // gone: it is the most expensive per unit of legibility, and at this tier
    // the text is sub-pixel anyway.
    orb: { neurons: 90, synapses: 140, protons: 60, glyphs: 0, shellRings: 12, shellMeridians: 12 },
  },
  medium: {
    dpr: [0.8, 1.5],
    bloom: true,
    godRays: false,
    depthOfField: true,
    chromaticAberration: true,
    transmissionSamples: 4,
    transmissionResolution: 256,
    particleCount: 1800,
    shadows: false,
    trackingHz: 30,
    fogDensity: 0.045,
    orb: {
      neurons: 240,
      synapses: 420,
      protons: 160,
      glyphs: 300,
      shellRings: 22,
      shellMeridians: 18,
    },
  },
  high: {
    dpr: [1, 2],
    bloom: true,
    godRays: true,
    depthOfField: true,
    chromaticAberration: true,
    transmissionSamples: 8,
    transmissionResolution: 512,
    particleCount: 4000,
    shadows: true,
    trackingHz: 60,
    fogDensity: 0.04,
    orb: {
      neurons: 600,
      synapses: 1200,
      protons: 400,
      glyphs: 1200,
      shellRings: 31,
      shellMeridians: 24,
    },
  },
}

export const getQuality = (tier: QualityTier): QualitySettings => QUALITY[tier]
