'use client'

import { create } from 'zustand'
import type { QualityTier } from '@/lib/device'
import type { BootPhase } from '@/core/types'

export interface TelemetrySnapshot {
  location: string
  temperatureC: number | null
  windKph: number | null
  /** WMO weather code — drives the environment's mood. */
  weatherCode: number | null
  condition: string
  isDay: boolean
  /** Source of truth for the reading, shown in the HUD so nothing is faked. */
  source: 'live' | 'unavailable'
  fetchedAt: number
}

interface SystemState {
  boot: BootPhase
  tier: QualityTier
  /** Set once at mount from device probing; the perf monitor may lower `tier`. */
  baseTier: QualityTier
  fps: number
  frameMs: number
  renderer: string
  reducedMotion: boolean
  /** Tier pinned via `?quality=` — the governor stands down. */
  pinned: boolean
  /**
   * Why the tier last moved, or null if it never has.
   *
   * Surfaced in the HUD. Without it "Quality: LOW" is ambiguous between a
   * machine that was only ever capable of low and one the governor demoted —
   * and those have completely different causes. Recovering that distinction
   * previously required reading the source.
   */
  tierReason: string | null
  telemetry: TelemetrySnapshot | null
  telemetryError: string | null

  setBoot: (boot: BootPhase) => void
  setTier: (tier: QualityTier) => void
  initDevice: (p: {
    tier: QualityTier
    renderer: string
    reducedMotion: boolean
    pinned: boolean
  }) => void
  setPerf: (fps: number, frameMs: number) => void
  setTelemetry: (t: TelemetrySnapshot | null, error?: string | null) => void
}

export const useSystemStore = create<SystemState>((set) => ({
  boot: 'cold',
  tier: 'medium',
  baseTier: 'medium',
  fps: 0,
  frameMs: 0,
  renderer: 'unknown',
  reducedMotion: false,
  pinned: false,
  tierReason: null,
  telemetry: null,
  telemetryError: null,

  setBoot: (boot) => set({ boot }),
  setTier: (tier) => set({ tier }),
  initDevice: ({ tier, renderer, reducedMotion, pinned }) =>
    set({ tier, baseTier: tier, renderer, reducedMotion, pinned }),
  // Called from the render loop, but throttled to ~2 Hz by the caller — this is
  // the one place we accept store writes near frame rate, and only because the
  // HUD genuinely has to display it.
  setPerf: (fps, frameMs) => set({ fps, frameMs }),
  setTelemetry: (telemetry, telemetryError = null) => set({ telemetry, telemetryError }),
}))
