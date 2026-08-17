'use client'

import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { QualitySettings } from '@/core/config/quality'
import { InfiniteGrid } from './InfiniteGrid'
import { Particulate } from './Particulate'
import { VolumetricFog } from './VolumetricFog'

/**
 * The lighting rig and world.
 *
 * Lighting here is doing narrative work, not just illumination. A key light
 * above and behind the carousel rims the glass edges; a cold fill from the
 * opposite side keeps the shadow faces from going black; a slow-moving
 * practical light sweeps the volume so the fog has something to catch.
 */

interface Props {
  quality: QualitySettings
  reducedMotion: boolean
}

export function Environment({ quality, reducedMotion }: Props) {
  const sweep = useRef<THREE.PointLight>(null)

  useFrame((state) => {
    if (!sweep.current || reducedMotion) return
    // A long orbit — slow enough to feel atmospheric rather than animated.
    const t = state.clock.elapsedTime * 0.12
    sweep.current.position.set(Math.cos(t) * 14, 5 + Math.sin(t * 0.6) * 3, Math.sin(t) * 14)
  })

  return (
    <>
      {/* Exponential-squared fog: the far plane should dissolve, not clip. */}
      <fogExp2 attach="fog" args={['#07070a', quality.fogDensity]} />
      <color attach="background" args={['#060607']} />

      <ambientLight intensity={0.28} color="#8fa4c8" />

      {/* Key — high and behind, to rim the glass. */}
      <directionalLight
        position={[6, 12, -8]}
        intensity={2.4}
        color="#d6e4ff"
        castShadow={quality.shadows}
        shadow-mapSize={[1024, 1024]}
        shadow-camera-far={40}
        shadow-bias={-0.0004}
      />

      {/* Cold fill, opposite side — stops shadow faces reading as holes. */}
      <directionalLight position={[-10, 4, 6]} intensity={0.7} color="#5a6a95" />

      {/* Warm bounce from below: pure cold light makes glass look like plastic. */}
      <pointLight position={[0, -4, 4]} intensity={12} distance={22} decay={2} color="#ffb27a" />

      <pointLight ref={sweep} intensity={26} distance={34} decay={2} color="#7c9cff" />

      <VolumetricFog density={quality.fogDensity} />
      <InfiniteGrid />
      <Particulate count={quality.particleCount} />
    </>
  )
}
