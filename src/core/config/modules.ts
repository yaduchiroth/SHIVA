import type { ModuleDescriptor } from '@/core/types'

/**
 * The carousel's contents.
 *
 * Phase 1 renders these as structurally-real panels: correct typography,
 * correct layout, correct interaction — with placeholder readouts where the
 * data source lands in a later phase. `liveIn` records that honestly rather
 * than letting mock data masquerade as real.
 */
export const MODULES: readonly ModuleDescriptor[] = [
  {
    id: 'system',
    label: 'System',
    code: 'SYS-00',
    summary: 'Runtime diagnostics, render budget, tracking pipeline',
    accent: 'var(--color-nominal)',
    liveIn: 1,
  },
  {
    id: 'weather',
    label: 'Environment',
    code: 'ENV-01',
    summary: 'Local conditions driving the volumetric environment',
    accent: 'var(--color-tracking)',
    liveIn: 1,
  },
  {
    id: 'calendar',
    label: 'Schedule',
    code: 'CAL-02',
    summary: 'Agenda, conflicts, meeting preparation',
    accent: 'var(--color-signal)',
    liveIn: 3,
  },
  {
    id: 'projects',
    label: 'Projects',
    code: 'PRJ-03',
    summary: 'Repositories, branches, review queue',
    accent: 'var(--color-signal-dim)',
    liveIn: 3,
  },
  {
    id: 'markets',
    label: 'Markets',
    code: 'MKT-04',
    summary: 'Portfolio exposure and sector performance',
    accent: 'var(--color-caution)',
    liveIn: 3,
  },
  {
    id: 'social',
    label: 'Reach',
    code: 'SOC-05',
    summary: 'Audience growth and engagement velocity',
    accent: 'var(--color-critical)',
    liveIn: 3,
  },
] as const

export const MODULE_COUNT = MODULES.length

export const getModule = (index: number): ModuleDescriptor => {
  // Carousel indices wrap in both directions and can go arbitrarily negative.
  const wrapped = ((index % MODULE_COUNT) + MODULE_COUNT) % MODULE_COUNT
  return MODULES[wrapped]!
}
