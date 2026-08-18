'use client'

import { useEffect, useMemo, useRef } from 'react'
import { Html } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { PALETTE } from '@/core/config/palette'
import { useSurfaceStore, type Surface as SurfaceModel } from '@/core/store/useSurfaceStore'
import { damp } from '@/lib/math'
import { emit } from '@/core/events/bus'
import { SURFACE_H, SURFACE_PX, SURFACE_SCALE, SURFACE_W, type SurfaceTransform } from './layout'
import { SurfaceBody } from './content/SurfaceBody'

/**
 * One screen in the room: a WebGL frame with live DOM inside it.
 *
 * The content is real HTML rather than a texture, and that is the whole point.
 * A report drawn into a canvas cannot be scrolled, selected, or contain a
 * working iframe, and its text is rasterised once at whatever size it was
 * drawn — which is exactly the softness that made the first version of this
 * interface look, in the user's words, pixelated and outdated. drei's `Html`
 * with `transform` positions the element with a CSS 3D transform instead, so
 * the browser rasterises the type at the scale it actually appears.
 *
 * What that costs, stated plainly: DOM cannot be occluded by scene geometry
 * (drei's `occlude` is a raycast approximation, deliberately not used here
 * because these surfaces sit in front of everything anyway), it does not
 * receive bloom or any other post effect, and it is composited by the browser
 * rather than the renderer. The frame around it is WebGL and does glow — which
 * is what keeps the two halves reading as one object.
 */

const FRAME = new THREE.Color(PALETTE['signal-dim'])
const FRAME_FOCUS = new THREE.Color(PALETTE.signal)

interface Props {
  surface: SurfaceModel
  transform: SurfaceTransform
}

export function Surface({ surface, transform }: Props) {
  const group = useRef<THREE.Group>(null)
  const border = useRef<THREE.LineSegments>(null)
  const focused = useSurfaceStore((s) => s.focused === surface.id)
  const focus = useSurfaceStore((s) => s.focus)
  const remove = useSurfaceStore((s) => s.remove)

  const borderGeometry = useMemo(
    () => new THREE.EdgesGeometry(new THREE.PlaneGeometry(SURFACE_W, SURFACE_H)),
    [],
  )
  useEffect(() => () => borderGeometry.dispose(), [borderGeometry])

  // The target is recomputed from the transform every frame rather than being
  // set once, so a surface arriving or leaving slides its neighbours into their
  // new slots instead of teleporting them.
  const target = useMemo(() => new THREE.Vector3(), [])
  const euler = useMemo(() => new THREE.Euler(), [])
  const quat = useMemo(() => new THREE.Quaternion(), [])

  useFrame((_, dt) => {
    const g = group.current
    if (!g) return
    const step = Math.min(dt, 0.05)

    target.set(...transform.position)
    euler.set(...transform.rotation)
    quat.setFromEuler(euler)

    // Focus pulls the surface toward the viewer along its own outward normal,
    // so it comes forward off the wall rather than sliding toward the centre of
    // the room and through its neighbours.
    if (focused) target.multiplyScalar(1.18)

    g.position.x = damp(g.position.x, target.x, 6, step)
    g.position.y = damp(g.position.y, target.y, 6, step)
    g.position.z = damp(g.position.z, target.z, 6, step)
    g.quaternion.slerp(quat, 1 - Math.exp(-6 * step))

    const mat = border.current?.material as THREE.LineBasicMaterial | undefined
    if (mat) {
      mat.color.lerp(focused ? FRAME_FOCUS : FRAME, 1 - Math.exp(-8 * step))
      mat.opacity = damp(mat.opacity, focused ? 0.95 : 0.45, 8, step)
    }
  })

  return (
    <group ref={group} position={transform.position} rotation={transform.rotation}>
      {/* Backing. Not transparent-black but a dark tint, so the volumetric
          environment behind still reads through and the surface belongs to the
          room rather than being a hole cut in it. */}
      <mesh>
        <planeGeometry args={[SURFACE_W, SURFACE_H]} />
        <meshBasicMaterial color={PALETTE.void} transparent opacity={0.72} depthWrite={false} />
      </mesh>

      <lineSegments ref={border} geometry={borderGeometry}>
        <lineBasicMaterial transparent opacity={0.45} toneMapped={false} depthWrite={false} />
      </lineSegments>

      <Html
        transform
        // Slightly in front of the backing plane. Coplanar, the browser's
        // compositing order and the depth buffer disagree and the panel flickers.
        position={[0, 0, 0.012]}
        distanceFactor={undefined}
        scale={SURFACE_SCALE}
        // Without this the portal is a sibling of the canvas at document
        // scale, and every surface would capture pointer events across the
        // whole viewport rather than only where it is drawn.
        style={{ width: SURFACE_PX.width, height: SURFACE_PX.height, pointerEvents: 'auto' }}
        zIndexRange={[10, 0]}
      >
        <div
          className="flex h-full w-full flex-col overflow-hidden"
          data-testid="surface"
          data-surface-id={surface.id}
          data-surface-kind={surface.content.kind}
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-steel)] px-3 py-2">
            <span className="truncate text-[10px] tracking-[0.22em] text-[var(--color-signal-dim)] uppercase">
              {surface.content.title || surface.content.kind}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              className="px-1 text-[10px] tracking-[0.18em] text-[var(--color-smoke)] uppercase hover:text-[var(--color-bone)] data-[hand-hover]:text-[var(--color-bone)]"
              onClick={(e) => {
                e.stopPropagation()
                focus(focused ? null : surface.id)
                emit('ui:confirm', { intensity: 0.4 })
              }}
              data-testid="surface-focus"
            >
              {focused ? 'Back' : 'Focus'}
            </button>
            <button
              type="button"
              className="px-1 text-[10px] tracking-[0.18em] text-[var(--color-smoke)] uppercase hover:text-[var(--color-critical)] data-[hand-hover]:text-[var(--color-critical)]"
              onClick={(e) => {
                e.stopPropagation()
                remove(surface.id)
              }}
              data-testid="surface-close"
            >
              Close
            </button>
          </header>

          {/* The scroll container the pointer bridge grabs. `overscroll-contain`
              stops a surface that has hit its end from scrolling the page
              behind it — which, with the canvas full-bleed, looks like the whole
              world lurching. */}
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-3">
            <SurfaceBody content={surface.content} />
          </div>
        </div>
      </Html>
    </group>
  )
}
