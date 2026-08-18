'use client'

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { orbDrive } from './orbDrive'

/**
 * The hot centre, and the two rings that sweep it.
 *
 * The only part of the orb still built from ordinary meshes, because there are
 * five of them and instancing five objects buys nothing. Kept close to the
 * reference implementation, which got the behaviour right: the core is mostly
 * near-transparent and occasionally surges, rather than glowing steadily. A
 * constant glow reads as a lamp; something that mostly rests and sometimes
 * flares reads as alive.
 *
 * The wireframe icosahedron stays visible through the fades on purpose. Without
 * it the centre of the orb periodically becomes genuinely empty, which looks
 * like a load failure rather than a breath.
 */

const CORE_R = 0.25

interface Props {
  reducedMotion: boolean
}

export function OrbCore({ reducedMotion }: Props) {
  const wire = useRef<THREE.LineSegments>(null)
  const hot = useRef<THREE.Mesh>(null)
  const halo = useRef<THREE.Mesh>(null)
  const ringA = useRef<THREE.Mesh>(null)
  const ringB = useRef<THREE.Mesh>(null)

  const wireGeometry = useMemo(
    () => new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(CORE_R, 1)),
    [],
  )

  const accent = useMemo(() => new THREE.Color(1, 1, 1), [])

  useFrame((_, dt) => {
    const t = orbDrive.time
    const step = Math.min(dt, 0.05)
    accent.setRGB(orbDrive.accent[0]!, orbDrive.accent[1]!, orbDrive.accent[2]!)

    // Two surge waves of different periods, each raised to a high power so they
    // are near zero most of the time and briefly large. Summing two of them
    // avoids the metronome regularity a single sine would give.
    const slow = Math.pow(Math.max(0, Math.sin(t * 0.4)), 5)
    const rare = Math.pow(Math.max(0, Math.sin(t * 0.7 + 2)), 8)
    const surge = slow * 1.5 + rare * 2 + orbDrive.surge * 2.2
    // A separate slow cycle takes the core to fully transparent now and then.
    const fade = Math.pow(Math.max(0, Math.sin(t * 0.25)), 3)
    orbDrive.surge *= Math.exp(-step * 2.4)

    if (hot.current) {
      hot.current.scale.setScalar(1 + surge + Math.sin(t * 5) * 0.05)
      const m = hot.current.material as THREE.MeshBasicMaterial
      m.opacity = Math.min(
        0.6,
        Math.max(0, (0.08 + Math.sin(t * 1.2) * 0.05 + surge * 0.2) * (1 - fade * 0.95)),
      )
      m.color.copy(accent)
    }
    if (halo.current) {
      halo.current.scale.setScalar(1 + surge * 0.8)
      const m = halo.current.material as THREE.MeshBasicMaterial
      m.opacity = Math.max(0, (0.03 + surge * 0.08) * (1 - fade * 0.9))
      m.color.copy(accent)
    }
    if (wire.current) {
      if (!reducedMotion) {
        wire.current.rotation.x += step * 0.5
        wire.current.rotation.y += step * 0.75
      }
      wire.current.scale.setScalar(1 + surge * 0.6)
      const m = wire.current.material as THREE.LineBasicMaterial
      m.opacity = Math.min(1, 0.5 + surge * 0.4)
      m.color.copy(accent)
    }

    // Rings sweep along the vertical axis, scaled to the chord of the sphere at
    // that height — so they read as a plane cutting through it rather than as a
    // hoop sliding past.
    sweep(ringA.current, Math.sin(t * 0.4) * 2, 2, 0.2, accent)
    sweep(ringB.current, Math.sin(t * 0.6 + 2) * 0.9, 0.9, 0.15, accent)
  })

  return (
    <group>
      <lineSegments ref={wire} geometry={wireGeometry} frustumCulled={false}>
        <lineBasicMaterial
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </lineSegments>

      <mesh ref={hot}>
        <sphereGeometry args={[0.15, 16, 16]} />
        <meshBasicMaterial transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>

      <mesh ref={halo}>
        <sphereGeometry args={[0.5, 16, 16]} />
        <meshBasicMaterial transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>

      <mesh ref={ringA} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.99, 2.01, 120]} />
        <meshBasicMaterial
          transparent
          opacity={0}
          depthWrite={false}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      <mesh ref={ringB} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.892, 0.908, 120]} />
        <meshBasicMaterial
          transparent
          opacity={0}
          depthWrite={false}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  )
}

/** Positions a scan ring at height `y` on a sphere of radius `r`. */
function sweep(
  mesh: THREE.Mesh | null,
  y: number,
  r: number,
  peak: number,
  accent: THREE.Color,
): void {
  if (!mesh) return
  mesh.position.y = y
  // Chord radius at this height, as a fraction of the sphere's own. Goes to
  // zero at the poles, which fades the ring out exactly where it would
  // otherwise pop from full size to nothing.
  const scale = Math.sqrt(Math.max(0, r * r - y * y)) / r
  mesh.scale.set(scale, scale, 1)
  const m = mesh.material as THREE.MeshBasicMaterial
  m.opacity = peak * scale
  m.color.copy(accent)
}
