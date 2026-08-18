'use client'

import { useMemo } from 'react'
import type { ChartSeries } from '@/core/store/useSurfaceStore'

/**
 * Bars and lines, drawn as SVG.
 *
 * SVG rather than Canvas2D because this lives inside a CSS-transformed DOM
 * surface: the browser rasterises it at whatever scale the transform lands on,
 * so it stays sharp when a surface is pulled forward. A canvas would be
 * rasterised once at its backing size and then magnified, which is exactly the
 * softness the rest of this interface goes out of its way to avoid.
 *
 * The axis starts at zero unless the data goes negative. Truncating a bar
 * chart's baseline to the data's minimum is the single most common way a chart
 * lies — it turns a 2% difference into a doubling — and SHIVA is supposed to be
 * an instrument.
 */

const PALETTE = ['#d6e4ff', '#4ade9a', '#f0b429', '#7c9cff', '#ff5a52', '#8fa4c8']

const W = 420
const H = 190
const PAD = { top: 12, right: 10, bottom: 26, left: 38 }

interface Props {
  ctype: 'bar' | 'line'
  labels: string[]
  series: ChartSeries[]
  unit: string
}

export function Chart({ ctype, labels, series, unit }: Props) {
  const model = useMemo(() => {
    const clean = series.filter((s) => s.values.length > 0)
    const all = clean.flatMap((s) => s.values).filter(Number.isFinite)
    if (all.length === 0) return null

    const max = Math.max(...all, 0)
    const min = Math.min(...all, 0)
    // Guard the degenerate case: a flat series at zero would make the range
    // zero and every coordinate NaN.
    const span = max - min || 1
    const cols = Math.max(...clean.map((s) => s.values.length))
    return { clean, max, min, span, cols }
  }, [series])

  if (!model) {
    return <p className="text-[11px] tracking-wide text-[var(--color-smoke)]">No numeric series.</p>
  }

  const { clean, max, min, span, cols } = model
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const yOf = (v: number) => PAD.top + plotH * (1 - (v - min) / span)
  const xOf = (i: number) => PAD.left + (cols <= 1 ? plotW / 2 : (i / (cols - 1)) * plotW)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="chart">
      {/* Gridlines and value labels at the extremes and the middle. Three is
          enough to read a magnitude from and few enough not to fight the data. */}
      {[max, (max + min) / 2, min].map((v, i) => (
        <g key={i}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={yOf(v)}
            y2={yOf(v)}
            stroke="#2a2a31"
            strokeWidth={1}
          />
          <text x={PAD.left - 6} y={yOf(v) + 3} textAnchor="end" fontSize={9} fill="#7a7a88">
            {format(v)}
          </text>
        </g>
      ))}

      {ctype === 'bar'
        ? clean.map((s, si) =>
            s.values.map((v, i) => {
              // Bars for each series sit side by side within their column, so
              // two series never hide one another.
              const slot = plotW / Math.max(1, cols)
              const bw = (slot * 0.66) / clean.length
              const x = PAD.left + i * slot + slot * 0.17 + si * bw
              const zero = yOf(Math.max(0, min))
              const y = yOf(v)
              return (
                <rect
                  key={`${si}-${i}`}
                  x={x}
                  y={Math.min(y, zero)}
                  width={Math.max(1, bw - 1)}
                  height={Math.max(1, Math.abs(zero - y))}
                  fill={PALETTE[si % PALETTE.length]}
                  opacity={0.85}
                />
              )
            }),
          )
        : clean.map((s, si) => (
            <polyline
              key={si}
              fill="none"
              stroke={PALETTE[si % PALETTE.length]}
              strokeWidth={1.6}
              strokeLinejoin="round"
              points={s.values.map((v, i) => `${xOf(i)},${yOf(v)}`).join(' ')}
            />
          ))}

      {/* Labels are thinned rather than rotated: rotated axis text in a
          surface that is itself already rotated in 3D becomes unreadable. */}
      {labels.map((label, i) => {
        const every = Math.ceil(labels.length / 6)
        if (i % every !== 0) return null
        const slot = plotW / Math.max(1, cols)
        const x = ctype === 'bar' ? PAD.left + i * slot + slot / 2 : xOf(i)
        return (
          <text key={i} x={x} y={H - 8} textAnchor="middle" fontSize={9} fill="#7a7a88">
            {label.slice(0, 10)}
          </text>
        )
      })}

      {unit ? (
        <text x={W - PAD.right} y={10} textAnchor="end" fontSize={9} fill="#4a4a55">
          {unit}
        </text>
      ) : null}
    </svg>
  )
}

/** Compact enough for a 38px gutter, without losing the magnitude. */
function format(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return abs >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1)
}
