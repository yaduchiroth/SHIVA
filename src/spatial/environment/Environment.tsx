'use client'

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { QualitySettings } from '@/core/config/quality'
import { InfiniteGrid } from './InfiniteGrid'
import { LightSource } from './LightSource'
import { Particulate } from './Particulate'
import { Precipitation } from './Precipitation'
import { StudioEnvironment } from './StudioEnvironment'
import { VolumetricFog } from './VolumetricFog'
import { useDataStore, type Sky } from '@/core/store/useDataStore'
import { damp } from '@/lib/math'
import { DRIFT, GLIDE } from '@/core/config/motion'

/**
 * The lighting rig and world.
 *
 * Lighting here is doing narrative work, not just illumination. A key light
 * above and behind the carousel rims the glass edges; a cold fill from the
 * opposite side keeps the shadow faces from going black; a slow-moving
 * practical light sweeps the volume so the fog has something to catch.
 *
 * The whole rig responds to the real weather where you are. That is the point
 * of Phase 3's environment work: not a weather widget, but a room that is
 * overcast when it is overcast outside, and dark when the sun has set. Every
 * transition is damped rather than switched, so conditions changing mid-session
 * reads as the light shifting rather than a scene reload.
 */

/** Per-condition atmosphere. Fog multiplies the tier's base density. */
const ATMOSPHERE: Record<Sky, { fog: number; key: number; ambient: number; tint: string }> = {
  clear: { fog: 0.85, key: 2.6, ambient: 0.3, tint: '#07070a' },
  cloudy: { fog: 1.35, key: 1.5, ambient: 0.4, tint: '#0a0b10' },
  // Fog is the one condition that should genuinely hurt visibility.
  fog: { fog: 2.6, key: 0.9, ambient: 0.55, tint: '#101218' },
  rain: { fog: 1.7, key: 1.1, ambient: 0.36, tint: '#080a10' },
  snow: { fog: 1.9, key: 1.4, ambient: 0.5, tint: '#0d0f16' },
  storm: { fog: 2.1, key: 0.8, ambient: 0.3, tint: '#06070c' },
}

/** Night pulls the key light down and cools everything. */
const NIGHT_KEY_SCALE = 0.45
const NIGHT_AMBIENT_SCALE = 0.7

interface Props {
  quality: QualitySettings
  reducedMotion: boolean
  /** Receives the god-ray light source so the effect stack can target it. */
  sunRef: React.Ref<THREE.Mesh>
}

export function Environment({ quality, reducedMotion, sunRef }: Props) {
  const sweep = useRef<THREE.PointLight>(null)
  const keyLight = useRef<THREE.DirectionalLight>(null)
  const ambient = useRef<THREE.AmbientLight>(null)
  const fog = useRef<THREE.FogExp2>(null)

  const weather = useDataStore((s) => s.weather)
  const sky: Sky = weather.status === 'live' && weather.data ? weather.data.sky : 'clear'
  const isDay = weather.status === 'live' && weather.data ? weather.data.isDay : true
  const target = ATMOSPHERE[sky]

  const tint = useMemo(() => new THREE.Color(target.tint), [target.tint])

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1)

    if (sweep.current && !reducedMotion) {
      // A long orbit — slow enough to feel atmospheric rather than animated.
      const t = state.clock.elapsedTime * 0.12
      sweep.current.position.set(Math.cos(t) * 14, 5 + Math.sin(t * 0.6) * 3, Math.sin(t) * 14)
    }

    // Damped, not assigned: weather updates arrive as a step change every ten
    // minutes, and snapping the lighting would look like a bug.
    if (fog.current) {
      fog.current.density = damp(fog.current.density, quality.fogDensity * target.fog, GLIDE, dt)
      fog.current.color.lerp(tint, 1 - Math.exp(-GLIDE * dt))
    }
    if (keyLight.current) {
      const wanted = target.key * (isDay ? 1 : NIGHT_KEY_SCALE)
      keyLight.current.intensity = damp(keyLight.current.intensity, wanted, GLIDE, dt)
    }
    if (ambient.current) {
      const wanted = target.ambient * (isDay ? 1 : NIGHT_AMBIENT_SCALE)
      ambient.current.intensity = damp(ambient.current.intensity, wanted, GLIDE, dt)
    }

    if (sweep.current && sky === 'storm' && !reducedMotion) {
      // Lightning: rare, brief, and driven by a steep power curve so the flash
      // is genuinely occasional rather than a strobe.
      const flash = Math.pow(Math.max(0, Math.sin(state.clock.elapsedTime * 1.7)), 60)
      sweep.current.intensity = 26 + flash * 340
    } else if (sweep.current) {
      sweep.current.intensity = damp(sweep.current.intensity, 26, DRIFT, dt)
    }
  })

  return (
    <>
      {/* Exponential-squared fog: the far plane should dissolve, not clip. */}
      <fogExp2 ref={fog} attach="fog" args={['#07070a', quality.fogDensity]} />
      <color attach="background" args={['#060607']} />

      {/* Reflection/refraction source for the glass. Without it the panels are
          transparent onto a black void and effectively invisible. */}
      <StudioEnvironment intensity={1.15} />

      <ambientLight ref={ambient} intensity={0.28} color="#8fa4c8" />

      {/* Key — high and behind, to rim the glass. */}
      <directionalLight
        ref={keyLight}
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

      {quality.godRays && <LightSource ref={sunRef} />}

      {/* Real precipitation when it is really raining or snowing on you. */}
      <Precipitation sky={sky} budget={Math.round(quality.particleCount * 0.7)} />

      <VolumetricFog density={quality.fogDensity} />
      <InfiniteGrid />
      <Particulate count={quality.particleCount} />
    </>
  )
}
