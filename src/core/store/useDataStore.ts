'use client'

import { create } from 'zustand'
import type { ModuleId } from '@/core/types'

/**
 * Live data for the module panels.
 *
 * One store rather than one per source, because the panels all need the same
 * three questions answered — do I have data, is it stale, did it fail — and
 * duplicating that per source is how the answers drift apart.
 *
 * The `status` union is load-bearing, not defensive typing. It forces every
 * consumer to distinguish "no data yet" from "this source isn't configured"
 * from "the fetch failed", which is what keeps an unconfigured panel from
 * rendering as an empty-but-plausible one.
 */

export type SourceStatus = 'idle' | 'loading' | 'live' | 'unconfigured' | 'error'

export interface SourceState<T> {
  status: SourceStatus
  data: T | null
  /** Populated for `unconfigured`: exactly which env vars are missing. */
  missing: string[]
  error: string | null
  fetchedAt: number
}

export interface SeriesPoint {
  label: string
  value: number
}

/** Runtime diagnostics — measured here, not fetched. */
export interface SystemSnapshot {
  fps: number
  frameMs: number
  renderer: string
  tier: string
  /** JS heap in MB, where the browser exposes it. */
  heapMB: number | null
  cores: number
  trackingHz: number
  inferenceMs: number
  /** Rolling frame-time history for the panel chart. */
  history: SeriesPoint[]
}

/** How the sky should look — drives the 3D environment, not just a label. */
export type Sky = 'clear' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm'

export interface WeatherSnapshot {
  temperatureC: number
  sky: Sky
  windKph: number | null
  weatherCode: number
  condition: string
  isDay: boolean
  location: string
  /** Next 12 hours of temperature, for the panel chart. */
  forecast: SeriesPoint[]
}

export interface RepoSnapshot {
  name: string
  defaultBranch: string
  openPullRequests: number
  awaitingReview: number
  lastCommitAt: string
  ciStatus: 'passing' | 'failing' | 'pending' | 'unknown'
}

export interface ScheduleSnapshot {
  events: {
    id: string
    title: string
    start: string
    end: string
    conflicting: boolean
  }[]
  unreadMail: number | null
}

const empty = <T>(): SourceState<T> => ({
  status: 'idle',
  data: null,
  missing: [],
  error: null,
  fetchedAt: 0,
})

interface DataState {
  system: SourceState<SystemSnapshot>
  weather: SourceState<WeatherSnapshot>
  projects: SourceState<RepoSnapshot[]>
  calendar: SourceState<ScheduleSnapshot>

  setSource: <K extends keyof DataState & ModuleId>(key: K, patch: Partial<DataState[K]>) => void
}

export const useDataStore = create<DataState>((set) => ({
  system: empty<SystemSnapshot>(),
  weather: empty<WeatherSnapshot>(),
  projects: empty<RepoSnapshot[]>(),
  calendar: empty<ScheduleSnapshot>(),

  setSource: (key, patch) =>
    set((state) => ({ [key]: { ...state[key], ...patch } }) as unknown as Partial<DataState>),
}))
