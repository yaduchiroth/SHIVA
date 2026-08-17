import { NextResponse } from 'next/server'

/**
 * Weather, with an hourly forecast for the panel chart.
 *
 * Supersedes the Phase 1 `/api/telemetry` reading: same keyless source, but it
 * now returns the series the Environment panel plots and the weather code that
 * drives the 3D environment's precipitation and cloud cover.
 */

export const runtime = 'edge'
export const revalidate = 600

/** WMO code → label, plus the environment condition it maps to. */
const WMO: Record<number, { label: string; sky: Sky }> = {
  0: { label: 'Clear', sky: 'clear' },
  1: { label: 'Mainly clear', sky: 'clear' },
  2: { label: 'Partly cloudy', sky: 'cloudy' },
  3: { label: 'Overcast', sky: 'cloudy' },
  45: { label: 'Fog', sky: 'fog' },
  48: { label: 'Rime fog', sky: 'fog' },
  51: { label: 'Light drizzle', sky: 'rain' },
  53: { label: 'Drizzle', sky: 'rain' },
  55: { label: 'Dense drizzle', sky: 'rain' },
  61: { label: 'Light rain', sky: 'rain' },
  63: { label: 'Rain', sky: 'rain' },
  65: { label: 'Heavy rain', sky: 'rain' },
  71: { label: 'Light snow', sky: 'snow' },
  73: { label: 'Snow', sky: 'snow' },
  75: { label: 'Heavy snow', sky: 'snow' },
  80: { label: 'Rain showers', sky: 'rain' },
  81: { label: 'Rain showers', sky: 'rain' },
  82: { label: 'Violent showers', sky: 'storm' },
  95: { label: 'Thunderstorm', sky: 'storm' },
  96: { label: 'Thunderstorm, hail', sky: 'storm' },
  99: { label: 'Thunderstorm, hail', sky: 'storm' },
}

export type Sky = 'clear' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const lat = Number(url.searchParams.get('lat'))
  const lon = Number(url.searchParams.get('lon'))

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ status: 'error', reason: 'lat and lon required' }, { status: 400 })
  }

  const endpoint = new URL('https://api.open-meteo.com/v1/forecast')
  endpoint.searchParams.set('latitude', lat.toFixed(3))
  endpoint.searchParams.set('longitude', lon.toFixed(3))
  endpoint.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m,is_day')
  endpoint.searchParams.set('hourly', 'temperature_2m')
  endpoint.searchParams.set('forecast_days', '1')
  endpoint.searchParams.set('timezone', 'auto')

  try {
    const res = await fetch(endpoint, {
      signal: AbortSignal.timeout(6000),
      next: { revalidate },
    })
    if (!res.ok) throw new Error(`upstream ${res.status}`)

    const data = (await res.json()) as {
      current?: {
        temperature_2m?: number
        weather_code?: number
        wind_speed_10m?: number
        is_day?: number
      }
      hourly?: { time?: string[]; temperature_2m?: number[] }
      timezone?: string
    }

    const current = data.current
    if (!current || typeof current.temperature_2m !== 'number') {
      throw new Error('upstream returned no current conditions')
    }

    const code = current.weather_code ?? 0
    const meta = WMO[code] ?? { label: 'Unknown', sky: 'clear' as Sky }

    // Twelve hours starting from now, not from midnight — a chart that starts
    // in the past is a chart nobody reads.
    const times = data.hourly?.time ?? []
    const temps = data.hourly?.temperature_2m ?? []
    const nowHour = new Date().getHours()
    const forecast = times
      .map((t, i) => ({
        label: t.slice(11, 16),
        value: temps[i] ?? 0,
        hour: Number(t.slice(11, 13)),
      }))
      .filter((p) => p.hour >= nowHour)
      .slice(0, 12)
      .map(({ label, value }) => ({ label, value }))

    return NextResponse.json({
      status: 'live' as const,
      data: {
        temperatureC: Math.round(current.temperature_2m),
        windKph: current.wind_speed_10m ?? null,
        weatherCode: code,
        condition: meta.label,
        sky: meta.sky,
        isDay: current.is_day !== 0,
        location: data.timezone ?? `${lat.toFixed(1)}, ${lon.toFixed(1)}`,
        forecast,
      },
      fetchedAt: Date.now(),
    })
  } catch (err) {
    // 200 with an explicit failure marker: a decorative readout failing is not
    // a failed page, and the client renders the outage honestly either way.
    return NextResponse.json({
      status: 'error' as const,
      reason: err instanceof Error ? err.message : 'unknown error',
      fetchedAt: Date.now(),
    })
  }
}
