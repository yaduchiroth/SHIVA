'use client'

import { useEffect, useMemo, useRef } from 'react'
import { Html } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { PALETTE } from '@/core/config/palette'
import { CAMERA_BASE } from '@/core/config/viewpoint'
import { useSurfaceStore, type Surface as SurfaceModel } from '@/core/store/useSurfaceStore'
import { damp } from '@/lib/math'
import { emit } from '@/core/events/bus'
import { SURFACE_H, SURFACE_PX, SURFACE_SCALE, SURFACE_W, type SurfaceTransform } from './layout'
import { SurfaceBody } from './content/SurfaceBody'
import { EASE, MAX_STEP, SETTLE, SNAP } from '@/core/config/motion'
import { WALL } from './layout'
import { dragState } from './useSurfaceDrag'

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

/** The eye, for pulling a focused surface toward it rather than toward the origin. */
const CAMERA = new THREE.Vector3(CAMERA_BASE.x, CAMERA_BASE.y, CAMERA_BASE.z)
const UP = new THREE.Vector3(0, 1, 0)

interface Props {
  surface: SurfaceModel
  transform: SurfaceTransform
}

export function Surface({ surface, transform }: Props) {
  const group = useRef<THREE.Group>(null)
  const border = useRef<THREE.LineSegments>(null)
  const plane = useRef<THREE.Mesh>(null)
  const focused = useSurfaceStore((s) => s.focused === surface.id)
  const grabbed = useSurfaceStore((s) => s.grabbed === surface.id)
  const focus = useSurfaceStore((s) => s.focus)
  const remove = useSurfaceStore((s) => s.remove)
  const setGrabbed = useSurfaceStore((s) => s.setGrabbed)
  const camera = useThree((s) => s.camera)

  const borderGeometry = useMemo(
    () => new THREE.EdgesGeometry(new THREE.PlaneGeometry(SURFACE_W, SURFACE_H)),
    [],
  )
  useEffect(() => () => borderGeometry.dispose(), [borderGeometry])

  // The target is recomputed every frame rather than set once, so a surface
  // arriving or leaving slides its neighbours into their new slots instead of
  // teleporting them.
  const target = useMemo(() => new THREE.Vector3(), [])
  const euler = useMemo(() => new THREE.Euler(), [])
  const quat = useMemo(() => new THREE.Quaternion(), [])
  const ray = useMemo(() => new THREE.Vector3(), [])
  const matrix = useMemo(() => new THREE.Matrix4(), [])
  /**
   * The transform is owned by the frame loop, not by React.
   *
   * Passing `position` and `rotation` as JSX props would look equivalent and
   * would silently defeat the damping: React reassigns them on every render,
   * and a re-render is exactly what a layout change causes — so every slot
   * change would snap into place and the interpolation below would only ever
   * run against a target it had already been teleported to.
   *
   * The first frame still snaps, because a surface should appear where it
   * belongs rather than flying in from the origin.
   */
  const placed = useRef(false)
  /**
   * 0 arriving, 1 present, back to 0 leaving.
   *
   * Driven in the frame loop and written straight to the DOM node's style,
   * never to React state — this changes every frame, and a state write per
   * frame would re-render the surface's whole content, iframe included, sixty
   * times a second.
   */
  const appear = useRef(0)
  const body = useRef<HTMLDivElement>(null)

  useFrame((_, dt) => {
    const g = group.current
    if (!g) return
    const step = Math.min(dt, MAX_STEP)

    if (grabbed) {
      // Held: the surface sits on the ray through the pointer, at the wall's
      // own distance. Following the ray rather than sliding along the wall is
      // what makes it feel picked up — it tracks the hand exactly, including
      // when the hand moves toward the edge of the frame where a flat mapping
      // would lag behind.
      const { x, y } = dragState()
      ray.set(x * 2 - 1, 1 - y * 2, 0.5).unproject(camera)
      ray.sub(camera.position).normalize().multiplyScalar(WALL.distance)
      target.copy(camera.position).add(ray)
      // Squared up to the viewer while held, so it reads as lifted off the wall.
      quat.setFromRotationMatrix(matrix.lookAt(camera.position, target, UP))
    } else {
      target.set(...transform.position)
      euler.set(...transform.rotation)
      quat.setFromEuler(euler)
    }

    // Focus pulls the surface toward the viewer along its own line of sight,
    // so it comes forward off the wall rather than sliding toward the middle
    // of the room and through its neighbours.
    if (focused && !grabbed) target.lerp(CAMERA, 0.18)

    if (!placed.current) {
      placed.current = true
      g.position.copy(target)
      g.quaternion.copy(quat)
    }

    // A held surface tracks faster than a settling one: anything you are
    // physically moving has to feel attached, and SETTLE reads as drag.
    const rate = grabbed ? SNAP : SETTLE
    g.position.x = damp(g.position.x, target.x, rate, step)
    g.position.y = damp(g.position.y, target.y, rate, step)
    g.position.z = damp(g.position.z, target.z, rate, step)
    g.quaternion.slerp(quat, 1 - Math.exp(-rate * step))

    // Arrive and leave, rather than appear and vanish. A surface that pops out
    // of existence mid-frame takes its neighbours' layout with it in the same
    // frame, which is the most jarring transition in the interface.
    appear.current = damp(appear.current, surface.removing ? 0 : 1, EASE, step)
    const eased = appear.current
    // Scale from 0.86 rather than 0: growing from nothing reads as a zoom
    // effect, while a small step up reads as something settling into place.
    g.scale.setScalar((0.86 + 0.14 * eased) * (surface.scale ?? 1))
    if (body.current) body.current.style.opacity = String(eased)

    const mat = border.current?.material as THREE.LineBasicMaterial | undefined
    if (mat) {
      mat.color.lerp(focused ? FRAME_FOCUS : FRAME, 1 - Math.exp(-EASE * step))
      mat.opacity = damp(mat.opacity, (focused ? 0.95 : 0.45) * eased, EASE, step)
    }
    const backing = plane.current?.material as THREE.MeshBasicMaterial | undefined
    if (backing) backing.opacity = 0.72 * eased
  })

  return (
    <group ref={group}>
      {/* Backing. Not transparent-black but a dark tint, so the volumetric
          environment behind still reads through and the surface belongs to the
          room rather than being a hole cut in it. */}
      <mesh ref={plane}>
        <planeGeometry args={[SURFACE_W, SURFACE_H]} />
        <meshBasicMaterial color={PALETTE.void} transparent opacity={0} depthWrite={false} />
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
          ref={body}
          style={{ opacity: 0 }}
          className="flex h-full w-full flex-col overflow-hidden"
          data-testid="surface"
          data-surface-id={surface.id}
          data-surface-kind={surface.content.kind}
        >
          {/* The header is the drag handle. A surface whose whole face is one
              cannot hold a scrollable report or a working button, and a
              modifier key is not something a hand can press. */}
          <header
            className="flex shrink-0 cursor-grab items-center gap-2 border-b border-[var(--color-steel)] px-3 py-2 active:cursor-grabbing"
            data-testid="surface-handle"
            onPointerDown={(e) => {
              // Not on the buttons: Focus and Close live in this bar, and a
              // press on either must not also pick the surface up.
              if ((e.target as HTMLElement).closest('button')) return
              setGrabbed(surface.id)
              emit('surface:grab', { id: surface.id })
            }}
          >
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
