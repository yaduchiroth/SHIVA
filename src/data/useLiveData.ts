'use client'

import { useEffect, useRef } from 'react'
import { useDataStore, type SeriesPoint } from '@/core/store/useDataStore'
import { useSystemStore } from '@/core/store/useSystemStore'
import { useGestureStore } from '@/core/store/useGestureStore'
import { getQuality } from '@/core/config/quality'
import { getDeviceProfile } from '@/lib/device'
import { handFrame } from '@/core/hands/handFrame'

/**
 * Drives every live data source.
 *
 * Two different kinds of source, handled differently on purpose:
 *
 *   - **Fetched** (weather, projects) poll a server route on a long interval.
 *     Their refresh rates reflect how fast the underlying thing actually
 *     changes — weather does not move in ten minutes, and GitHub rate-limits.
 *   - **Measured** (system) is sampled in-browser from what the renderer is
 *     genuinely doing. Nothing is fetched, because the numbers already exist.
 *
 * Every source lands in the same three-state union, so a panel renders "live",
 * "not configured" or "failed" identically regardless of where its data came
 * from.
 */

const WEATHER_REFRESH_MS = 10 * 60 * 1000
const PROJECTS_REFRESH_MS = 3 * 60 * 1000
const SYSTEM_SAMPLE_MS = 1000
/** Points kept in the system frame-time chart. */
const HISTORY_LENGTH = 24

interface ApiEnvelope<T> {
  status: 'live' | 'unconfigured' | 'error'
  data?: T
  missing?: string[]
  reason?: string
  fetchedAt: number
}

export function useLiveData() {
  const setSource = useDataStore((s) => s.setSource)
  const history = useRef<SeriesPoint[]>([])

  // ── Fetched sources ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    const load = async <T>(key: 'weather' | 'projects', url: string) => {
      if (cancelled) return
      // Only show a spinner on the first load. Flipping an already-populated
      // panel back to "loading" on every poll makes live data look unstable.
      if (useDataStore.getState()[key].status === 'idle') {
        setSource(key, { status: 'loading' })
      }

      try {
        const res = await fetch(url)
        const body = (await res.json()) as ApiEnvelope<T>
        if (cancelled) return

        if (body.status === 'live' && body.data !== undefined) {
          setSource(key, {
            status: 'live',
            data: body.data as never,
            error: null,
            missing: [],
            fetchedAt: body.fetchedAt,
          })
        } else if (body.status === 'unconfigured') {
          setSource(key, {
            status: 'unconfigured',
            missing: body.missing ?? [],
            error: null,
            fetchedAt: body.fetchedAt,
          })
        } else {
          setSource(key, { status: 'error', error: body.reason ?? 'Unknown error' })
        }
      } catch (err) {
        if (!cancelled) setSource(key, { status: 'error', error: (err as Error).message })
      }
    }

    const loadWeather = () => {
      const fallbackLat = Number(process.env.NEXT_PUBLIC_DEFAULT_LAT)
      const fallbackLon = Number(process.env.NEXT_PUBLIC_DEFAULT_LON)
      const hasFallback = Number.isFinite(fallbackLat) && Number.isFinite(fallbackLon)

      const go = (lat: number, lon: number) =>
        void load('weather', `/api/data/weather?lat=${lat}&lon=${lon}`)

      if (!navigator.geolocation) {
        if (hasFallback) go(fallbackLat, fallbackLon)
        else setSource('weather', { status: 'error', error: 'No location source available.' })
        return
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => go(pos.coords.latitude, pos.coords.longitude),
        () => {
          if (hasFallback) go(fallbackLat, fallbackLon)
          else
            setSource('weather', {
              status: 'error',
              error: 'Location denied — set NEXT_PUBLIC_DEFAULT_LAT/LON.',
            })
        },
        // A stale fix is fine for weather; a fresh one spins the GPS radio for
        // no benefit.
        { timeout: 8000, maximumAge: 30 * 60 * 1000, enableHighAccuracy: false },
      )
    }

    loadWeather()
    void load('projects', '/api/data/projects')

    const weatherTimer = window.setInterval(loadWeather, WEATHER_REFRESH_MS)
    const projectsTimer = window.setInterval(
      () => void load('projects', '/api/data/projects'),
      PROJECTS_REFRESH_MS,
    )

    return () => {
      cancelled = true
      clearInterval(weatherTimer)
      clearInterval(projectsTimer)
    }
  }, [setSource])

  // ── Measured source ────────────────────────────────────────────────────────
  useEffect(() => {
    const profile = getDeviceProfile()

    const sample = () => {
      const system = useSystemStore.getState()
      const quality = getQuality(system.tier)

      history.current = [
        ...history.current,
        { label: '', value: Number(system.frameMs.toFixed(2)) },
      ].slice(-HISTORY_LENGTH)

      // `performance.memory` is Chromium-only and absent elsewhere; null rather
      // than a zero, so the panel can omit it instead of claiming 0 MB.
      const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      const heapMB = memory ? Math.round(memory.usedJSHeapSize / 1048576) : null

      setSource('system', {
        status: 'live',
        error: null,
        fetchedAt: Date.now(),
        data: {
          fps: system.fps,
          frameMs: system.frameMs,
          renderer: system.renderer,
          tier: system.tier,
          heapMB,
          cores: profile.cores,
          trackingHz: quality.trackingHz,
          inferenceMs: Number(handFrame.inferenceMs.toFixed(1)),
          history: history.current,
        },
      })
    }

    sample()
    const timer = window.setInterval(sample, SYSTEM_SAMPLE_MS)
    return () => clearInterval(timer)
  }, [setSource])

  // Keep the Phase 1 HUD telemetry in step with the richer weather source, so
  // there is one reading in the interface rather than two that can disagree.
  const weather = useDataStore((s) => s.weather)
  const setTelemetry = useSystemStore((s) => s.setTelemetry)
  useEffect(() => {
    if (weather.status === 'live' && weather.data) {
      setTelemetry({
        location: weather.data.location,
        temperatureC: weather.data.temperatureC,
        windKph: weather.data.windKph,
        weatherCode: weather.data.weatherCode,
        condition: weather.data.condition,
        isDay: weather.data.isDay,
        source: 'live',
        fetchedAt: weather.fetchedAt,
      })
    } else if (weather.status === 'error') {
      setTelemetry(null, weather.error)
    }
  }, [weather, setTelemetry])

  // Tracking rate feeds the system panel; subscribing keeps it fresh without a
  // second timer.
  useGestureStore((s) => s.inferenceMs)
}
