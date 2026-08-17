import type { QualityTier } from '@/lib/device'

/**
 * Per-tier render budget.
 *
 * Every expensive feature is expressed here rather than hard-coded in
 * components, so degrading gracefully is a data change rather than a hunt
 * through the scene graph.
 */
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
  },
}

export const getQuality = (tier: QualityTier): QualitySettings => QUALITY[tier]
