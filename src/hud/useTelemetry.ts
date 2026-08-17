'use client'

import { useEffect } from 'react'
import { useSystemStore, type TelemetrySnapshot } from '@/core/store/useSystemStore'

const REFRESH_MS = 10 * 60 * 1000

/**
 * Pulls live conditions for the HUD.
 *
 * Location resolution is best-effort and never blocks: browser geolocation if
 * the user has already granted it, otherwise the configured fallback, otherwise
 * nothing at all. SHIVA does not prompt for location on boot — stacking a
 * second permission dialog on top of the camera request is a good way to have
 * both refused.
 */
export function useTelemetry() {
  const setTelemetry = useSystemStore((s) => s.setTelemetry)

  useEffect(() => {
    let cancelled = false

    const load = async (lat: number, lon: number) => {
      try {
        const res = await fetch(`/api/telemetry?lat=${lat}&lon=${lon}`)
        const data = (await res.json()) as
          | (TelemetrySnapshot & { source: 'live' })
          | { source: 'unavailable'; reason: string; fetchedAt: number }

        if (cancelled) return

        if (data.source === 'live') {
          setTelemetry(data)
        } else {
          setTelemetry(null, data.reason)
        }
      } catch (err) {
        if (!cancelled) setTelemetry(null, (err as Error).message)
      }
    }

    const resolveLocation = () => {
      const fallbackLat = Number(process.env.NEXT_PUBLIC_DEFAULT_LAT)
      const fallbackLon = Number(process.env.NEXT_PUBLIC_DEFAULT_LON)
      const hasFallback = Number.isFinite(fallbackLat) && Number.isFinite(fallbackLon)

      if (!navigator.geolocation) {
        if (hasFallback) void load(fallbackLat, fallbackLon)
        else setTelemetry(null, 'No location source configured.')
        return
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => void load(pos.coords.latitude, pos.coords.longitude),
        () => {
          if (hasFallback) void load(fallbackLat, fallbackLon)
          else setTelemetry(null, 'Location unavailable.')
        },
        // A stale fix is fine for weather, and asking for a fresh one spins up
        // the GPS radio for no benefit.
        { timeout: 8000, maximumAge: 30 * 60 * 1000, enableHighAccuracy: false },
      )
    }

    resolveLocation()
    const timer = window.setInterval(resolveLocation, REFRESH_MS)

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [setTelemetry])
}
