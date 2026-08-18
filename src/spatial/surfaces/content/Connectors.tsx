'use client'

import type { ConnectorItem } from '@/core/store/useSurfaceStore'

/**
 * What Odin is wired into, and what it is not.
 *
 * Three states, not two. "Connected" and "not connected" are the obvious pair,
 * and they lose the one that matters most: Odin frequently reports a device it
 * knows about without saying whether it is reachable, and rendering that as a
 * red dot is a false alarm about something that is very likely fine. Unknown
 * gets its own, quieter mark.
 */

const DOT: Record<'on' | 'off' | 'unknown', { color: string; label: string }> = {
  on: { color: 'var(--color-nominal)', label: 'online' },
  off: { color: 'var(--color-critical)', label: 'offline' },
  unknown: { color: 'var(--color-ash)', label: 'unknown' },
}

const stateOf = (item: ConnectorItem): keyof typeof DOT =>
  item.online === undefined ? 'unknown' : item.online ? 'on' : 'off'

export function Connectors({ items }: { items: ConnectorItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-[12px] text-[var(--color-smoke)]">
        Odin has not reported any connectors yet.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-1.5" data-testid="connectors">
      {items.map((item) => {
        const dot = DOT[stateOf(item)]
        return (
          <li key={item.name} className="flex items-baseline gap-2.5">
            <span
              aria-label={dot.label}
              className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: dot.color }}
            />
            <span className="text-[12px] text-[var(--color-bone)]">{item.name}</span>
            {item.status ? (
              <span className="text-[11px] text-[var(--color-signal-dim)]">{item.status}</span>
            ) : null}
            <span className="flex-1" />
            {item.detail ? (
              <span className="truncate text-[11px] text-[var(--color-smoke)]">{item.detail}</span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
