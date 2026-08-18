'use client'

import type { SurfaceContent } from '@/core/store/useSurfaceStore'
import { Chart } from './Chart'
import { Report } from './Report'
import { WebFrame } from './WebFrame'

/**
 * Picks the renderer for a surface's content.
 *
 * The switch is exhaustive and the `never` at the end enforces it: adding a
 * kind to the union without handling it here fails the typecheck, rather than
 * rendering nothing on whichever machine first receives one.
 */
export function SurfaceBody({ content }: { content: SurfaceContent }) {
  switch (content.kind) {
    case 'card':
      return (
        <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-[var(--color-mist)]">
          {content.body}
        </p>
      )
    case 'report':
      return <Report html={content.html} />
    case 'chart':
      return (
        <Chart
          ctype={content.ctype}
          labels={content.labels}
          series={content.series}
          unit={content.unit}
        />
      )
    case 'web':
      return <WebFrame url={content.url} title={content.title} />
    default: {
      const exhaustive: never = content
      return exhaustive
    }
  }
}
