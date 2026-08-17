import { NextResponse } from 'next/server'

/**
 * Keyless live telemetry.
 *
 * Open-Meteo needs no API key, which is why it's the one live source Phase 1
 * ships with. Fetched server-side rather than from the browser so the client
 * never talks to a third party directly and the response can be cached across
 * users of the same deployment.
 *
 * The contract this route keeps: it never invents data. If the upstream is
 * unreachable it says so, and the HUD displays the outage rather than a
 * plausible-looking temperature.
 */

export const runtime = 'edge'
// Weather doesn't change meaningfully inside ten minutes, and this endpoint is
// polled by every client.
export const revalidate = 600

const WMO: Record<number, string> = {
  0: 'Clear',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  80: 'Rain showers',
  81: 'Rain showers',
  82: 'Violent showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm, hail',
  99: 'Thunderstorm, hail',
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const lat = Number(url.searchParams.get('lat'))
  const lon = Number(url.searchParams.get('lon'))

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: 'lat and lon are required' }, { status: 400 })
  }

  const endpoint = new URL('https://api.open-meteo.com/v1/forecast')
  endpoint.searchParams.set('latitude', lat.toFixed(3))
  endpoint.searchParams.set('longitude', lon.toFixed(3))
  endpoint.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m,is_day')
  endpoint.searchParams.set('timezone', 'auto')

  try {
    // Bounded so a hanging upstream can't hold an edge function open to its
    // full duration limit.
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
      timezone?: string
    }

    const current = data.current
    if (!current || typeof current.temperature_2m !== 'number') {
      throw new Error('upstream returned no current conditions')
    }

    const code = current.weather_code ?? 0
    return NextResponse.json({
      source: 'live' as const,
      location: data.timezone ?? `${lat.toFixed(1)}, ${lon.toFixed(1)}`,
      temperatureC: Math.round(current.temperature_2m),
      windKph: current.wind_speed_10m ?? null,
      weatherCode: code,
      condition: WMO[code] ?? 'Unknown',
      isDay: current.is_day !== 0,
      fetchedAt: Date.now(),
    })
  } catch (err) {
    // 200 with an explicit unavailable marker, not an error status: this is a
    // decorative readout, and a failed weather lookup is not a failed page.
    // The client renders the outage honestly.
    return NextResponse.json({
      source: 'unavailable' as const,
      reason: err instanceof Error ? err.message : 'unknown error',
      fetchedAt: Date.now(),
    })
  }
}
