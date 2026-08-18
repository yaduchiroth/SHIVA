'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { buildShell, type Rgb } from './geometry'
import { orbDrive } from './orbDrive'

/**
 * The wireframe sphere: latitude rings, meridians, bright cross bands and a
 * scatter of loose arcs — all in a single `LineSegments`.
 *
 * Merging them is the entire trick. Drawn as separate `THREE.Line` objects, as
 * in the reference build, this is around 250 draw calls for one wireframe;
 * merged into one buffer it is one. What made that possible was giving up the
 * per-line opacity a separate material would have provided and folding it into
 * the vertex colour instead, which additive blending makes exact rather than
 * approximate: at half brightness a line contributes half as much light, which
 * is what half opacity meant anyway.
 *
 * Counter-rotation between the two shells is what gives the orb its depth. With
 * both turning the same way it reads as a single textured ball.
 */

interface Props {
  radius: number
  rings: number
  meridians: number
  bright: Rgb
  mid: Rgb
  faint: Rgb
  seed: number
  reducedMotion: boolean
}

export function Shell({
  radius,
  rings,
  meridians,
  bright,
  mid,
  faint,
  seed,
  reducedMotion,
}: Props) {
  const group = useRef<THREE.Group>(null)

  const built = useMemo(
    () =>
      buildShell({
        radius,
        rings,
        meridians,
        // 96 samples keeps a 2-unit ring smooth at the closest the camera can
        // dolly. Higher is invisible; lower shows as faceting on the bright
        // bands, where it is most obvious.
        segments: 96,
        crossBands: 4,
        // The bands read as bands rather than as stripes from about a dozen
        // lines up; below that they look like a picket fence.
        crossLines: Math.max(6, Math.round(rings * 0.6)),
        equatorLines: Math.max(6, Math.round(rings * 0.65)),
        arcs: Math.max(6, Math.round(rings * 0.9)),
        bright,
        mid,
        faint,
        seed,
      }),
    [radius, rings, meridians, bright, mid, faint, seed],
  )

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(built.positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(built.colors, 3))
    return geo
  }, [built])

  useEffect(() => () => geometry.dispose(), [geometry])

  useFrame((_, dt) => {
    const g = group.current
    if (!g || reducedMotion) return
    // Clamped: a tab restored after being backgrounded delivers one enormous
    // delta, which without this spins the orb through several turns in a
    // single frame.
    const step = Math.min(dt, 0.05)
    const rate = 0.16 + orbDrive.energy * 0.35
    g.rotation.y += step * rate
    g.rotation.x = Math.sin(orbDrive.time * 0.08) * 0.05
  })

  return (
    <group ref={group}>
      <lineSegments geometry={geometry} frustumCulled={false}>
        <lineBasicMaterial
          vertexColors
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          // Bypasses ACES so the wireframe keeps the exact brightness it was
          // authored at. Safe here only because every colour is at or below
          // 1.0 — above that, tone mapping is what stops highlights clipping,
          // and skipping it turns them into flat gold.
          toneMapped={false}
        />
      </lineSegments>
    </group>
  )
}
