import type { ModuleId } from '@/core/types'
import type { SeriesPoint, SourceState } from '@/core/store/useDataStore'
import type { SystemSnapshot, WeatherSnapshot, RepoSnapshot } from '@/core/store/useDataStore'
import { useDataStore } from '@/core/store/useDataStore'

/**
 * Turns a module's live source into what its panel face should show.
 *
 * The point of routing every panel through one shape is that "no data" has a
 * single rendering everywhere. A panel that is unconfigured says which variable
 * is missing; one that failed says why; one with no source yet says which phase
 * it arrives in. None of them render an empty chart, because an empty chart
 * reads as "zero" rather than "unknown" — and that is the difference between an
 * instrument and a decoration.
 */

export interface PanelReadout {
  /** Large figure, e.g. "21°C". Empty when there's nothing to headline. */
  headline: string
  /** Small caption under the headline. */
  caption: string
  /** Bars to plot. Empty means draw the placeholder lattice instead. */
  series: SeriesPoint[]
  /** Key/value rows beneath the chart. */
  rows: { label: string; value: string }[]
  status: 'live' | 'pending' | 'unconfigured' | 'error'
  /** Shown on the status line: why there's no data. */
  note: string
}

const relativeTime = (iso: string): string => {
  if (!iso) return 'unknown'
  const delta = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(delta)) return 'unknown'
  const minutes = Math.floor(delta / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Shared handling for a source that has no data to show. */
function fallback<T>(source: SourceState<T>, pendingPhase: number | null): PanelReadout | null {
  if (source.status === 'unconfigured') {
    return {
      headline: '',
      caption: 'Not configured',
      series: [],
      rows: source.missing.map((key) => ({ label: 'Needs', value: key })),
      status: 'unconfigured',
      note: source.missing.length ? `SET ${source.missing.join(', ')}` : 'NOT CONFIGURED',
    }
  }
  if (source.status === 'error') {
    return {
      headline: '',
      caption: source.error ?? 'Unavailable',
      series: [],
      rows: [],
      status: 'error',
      note: 'SOURCE UNAVAILABLE',
    }
  }
  if (source.status !== 'live' || !source.data) {
    return {
      headline: '',
      caption: pendingPhase ? `Source arrives in Phase ${pendingPhase}` : 'Acquiring…',
      series: [],
      rows: [],
      status: 'pending',
      note: pendingPhase ? `AWAITING PHASE ${pendingPhase}` : 'ACQUIRING',
    }
  }
  return null
}

export function readPanel(module: ModuleId): PanelReadout {
  const state = useDataStore.getState()

  switch (module) {
    case 'system': {
      const miss = fallback<SystemSnapshot>(state.system, null)
      if (miss) return miss
      const d = state.system.data!
      return {
        headline: `${d.fps} fps`,
        caption: `${d.frameMs.toFixed(1)} ms per frame · ${d.tier.toUpperCase()} tier`,
        series: d.history,
        rows: [
          { label: 'Renderer', value: d.renderer.slice(0, 28) },
          { label: 'Cores', value: String(d.cores) },
          ...(d.heapMB !== null ? [{ label: 'Heap', value: `${d.heapMB} MB` }] : []),
          { label: 'Tracking', value: `${d.trackingHz} Hz · ${d.inferenceMs} ms` },
        ],
        status: 'live',
        note: 'LIVE',
      }
    }

    case 'weather': {
      const miss = fallback<WeatherSnapshot>(state.weather, null)
      if (miss) return miss
      const d = state.weather.data!
      return {
        headline: `${d.temperatureC}°C`,
        caption: `${d.condition} · ${d.isDay ? 'day' : 'night'}`,
        series: d.forecast,
        rows: [
          { label: 'Location', value: d.location },
          ...(d.windKph !== null
            ? [{ label: 'Wind', value: `${Math.round(d.windKph)} km/h` }]
            : []),
          { label: 'Sky', value: d.sky },
        ],
        status: 'live',
        note: 'LIVE',
      }
    }

    case 'projects': {
      const miss = fallback<RepoSnapshot[]>(state.projects, null)
      if (miss) return miss
      const repos = state.projects.data ?? []
      const openPRs = repos.reduce((sum, r) => sum + r.openPullRequests, 0)
      const awaiting = repos.reduce((sum, r) => sum + r.awaitingReview, 0)
      const failing = repos.filter((r) => r.ciStatus === 'failing').length

      return {
        headline: String(openPRs),
        caption: `open pull requests across ${repos.length} repositories`,
        // Bar per repo, so the busiest is visible at a glance.
        series: repos.map((r) => ({ label: r.name.slice(0, 8), value: r.openPullRequests })),
        rows: [
          { label: 'Awaiting you', value: String(awaiting) },
          {
            label: 'CI failing',
            value: failing ? `${failing} repo${failing > 1 ? 's' : ''}` : 'none',
          },
          ...(repos[0]
            ? [
                {
                  label: 'Latest',
                  value: `${repos[0].name} · ${relativeTime(repos[0].lastCommitAt)}`,
                },
              ]
            : []),
        ],
        status: 'live',
        note: 'LIVE',
      }
    }

    case 'calendar':
      return (
        fallback(state.calendar, 3) ?? {
          headline: '',
          caption: '',
          series: [],
          rows: [],
          status: 'pending',
          note: 'AWAITING PHASE 3',
        }
      )

    default:
      // Markets and Reach have no source yet, and say so rather than showing a
      // chart of nothing.
      return {
        headline: '',
        caption: 'Source not connected',
        series: [],
        rows: [],
        status: 'pending',
        note: 'NOT CONNECTED',
      }
  }
}
