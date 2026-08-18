'use client'

import { useSpatialStore, activeModuleIndex } from '@/core/store/useSpatialStore'
import { useSystemStore } from '@/core/store/useSystemStore'
import { MODULES } from '@/core/config/modules'
import { emit } from '@/core/events/bus'
import { readPanel } from '@/spatial/carousel/panelContent'
import { useSurfaceStore, type ChartSeries } from '@/core/store/useSurfaceStore'
import type { ModuleId, QualityTierName } from '@/core/types'

/**
 * Maps a tool call to interface actions. Returns what happened, for the log.
 *
 * Extracted from `useBrain` because there are now two brains that can call
 * these: the typed conversation with Gemini, and the spoken conversation inside
 * the Deepgram voice socket. They must resolve identically — if voice had its
 * own copy of "focus a module", the two would drift and the same sentence would
 * do different things depending on whether it was typed or said.
 *
 * Everything here resolves to bus events or store writes the gesture layer
 * already uses, so a spoken command and a hand gesture end up in the same code.
 */
export function executeTool(name: string, args: Record<string, unknown>): string {
  const spatial = useSpatialStore.getState()

  switch (name) {
    case 'focus_module': {
      const moduleId = args.module as ModuleId
      const index = MODULES.findIndex((m) => m.id === moduleId)
      if (index < 0) return `unknown module: ${moduleId}`

      // The carousel index is unbounded and wraps, so stepping to a specific
      // panel means finding the shortest path from wherever it currently is —
      // not assigning an absolute index, which could spin it the long way round.
      const current = spatial.index
      const currentSlot = activeModuleIndex(current)
      let delta = index - currentSlot
      const count = MODULES.length
      if (delta > count / 2) delta -= count
      if (delta < -count / 2) delta += count

      spatial.setIndex(current + delta)
      spatial.focus(index)
      return `focused ${moduleId}`
    }

    case 'rotate_carousel': {
      const direction = args.direction === 'left' ? -1 : 1
      emit('carousel:step', { direction })
      return `rotated ${args.direction}`
    }

    case 'dismiss': {
      spatial.focus(null)
      return 'dismissed'
    }

    case 'read_module': {
      // Returns the same readout the panel renders, so what SHIVA says and what
      // you can see on the panel are the same numbers by construction.
      const readout = readPanel(args.module as ModuleId)
      if (readout.status !== 'live') {
        return `${args.module}: no live data (${readout.note})`
      }
      const rows = readout.rows.map((r) => `${r.label}: ${r.value}`).join('; ')
      return `${args.module}: ${readout.headline} — ${readout.caption}. ${rows}`
    }

    case 'show_card': {
      useSurfaceStore.getState().push({
        kind: 'card',
        title: String(args.title ?? ''),
        body: String(args.body ?? ''),
      })
      return 'card placed in the room'
    }

    case 'show_report': {
      const html = String(args.html ?? '')
      if (!html.trim()) return 'nothing to show: the report was empty'
      useSurfaceStore.getState().push({
        kind: 'report',
        title: String(args.title ?? ''),
        html,
      })
      return 'report placed in the room'
    }

    case 'show_chart': {
      // Models are inconsistent about this key — values, data and y all turn up
      // — and a chart that silently renders nothing because the array was
      // called the wrong thing is a bad failure. The mind's own HUD tool normalises
      // the same three; this matches it deliberately.
      const raw = Array.isArray(args.series) ? (args.series as Record<string, unknown>[]) : []
      const series: ChartSeries[] = raw
        .map((s) => ({
          name: String(s?.name ?? s?.label ?? ''),
          values: toNumbers(s?.values ?? s?.data ?? s?.y),
        }))
        .filter((s) => s.values.length > 0)

      if (series.length === 0) return 'nothing to plot: no series had numeric values'

      useSurfaceStore.getState().push({
        kind: 'chart',
        title: String(args.title ?? ''),
        ctype: args.type === 'line' ? 'line' : 'bar',
        labels: Array.isArray(args.labels) ? args.labels.map(String) : [],
        series,
        unit: String(args.unit ?? ''),
      })
      return `chart placed in the room (${series.length} series)`
    }

    case 'open_page': {
      const url = String(args.url ?? '').trim()
      // Anything but http(s) here is either a mistake or an attempt at
      // javascript:/data: — neither belongs in a frame we are about to mount.
      if (!/^https?:\/\//i.test(url)) return 'I need a full http or https URL'
      useSurfaceStore.getState().push({ kind: 'web', url, title: String(args.title ?? url) })
      return `opened ${url} in the room`
    }

    case 'clear_surfaces': {
      useSurfaceStore.getState().clear()
      return 'surfaces cleared'
    }

    case 'set_quality': {
      const tier = args.tier as QualityTierName
      if (tier !== 'low' && tier !== 'medium' && tier !== 'high') return `unknown tier: ${tier}`
      useSystemStore.getState().setTier(tier)
      return `quality set to ${tier}`
    }

    default:
      return `unknown tool: ${name}`
  }
}

/** Coerces whatever the model sent into a numeric array, dropping the rest. */
function toNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => (typeof v === 'number' ? v : Number(String(v).replace(/[^0-9eE+.-]/g, ''))))
    .filter((n) => Number.isFinite(n))
}
