'use client'

import { useSurfaceStore } from '@/core/store/useSurfaceStore'
import { Surface } from './Surface'
import { slotTransform } from './layout'

/**
 * Every live surface, laid out on the arc.
 *
 * Deliberately thin: it owns nothing but the mapping from list index to slot,
 * and re-renders only when a surface is added, removed or replaced. The motion
 * that follows — surfaces sliding into their new slots — happens inside each
 * `Surface`'s own frame loop, so adding a screen does not re-render the ones
 * already there while they animate.
 */
export function SurfaceWall() {
  const surfaces = useSurfaceStore((s) => s.surfaces)
  if (surfaces.length === 0) return null

  return (
    <group>
      {surfaces.map((surface, i) => (
        <Surface key={surface.id} surface={surface} transform={slotTransform(i, surfaces.length)} />
      ))}
    </group>
  )
}
