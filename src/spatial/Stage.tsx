'use client'

import { Suspense, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import { AdaptiveDpr, Preload } from '@react-three/drei'
import * as THREE from 'three'
import { getQuality } from '@/core/config/quality'
import { getDeviceProfile } from '@/lib/device'
import { useSystemStore } from '@/core/store/useSystemStore'
import { Environment } from './environment/Environment'
import { EffectStack } from './effects/EffectStack'
import { CameraRig } from './CameraRig'
import { PerformanceGovernor } from './PerformanceGovernor'
import { Carousel } from './carousel/Carousel'
import { HandCursors } from './hands/HandCursors'

/**
 * The render surface.
 *
 * Everything visual hangs off this. The Canvas is configured once with the
 * colour-management settings that make the rest of the aesthetic possible —
 * getting tone mapping and colour space wrong here makes every downstream
 * material look subtly plastic no matter how it's authored.
 */
export function Stage() {
  const tier = useSystemStore((s) => s.tier)
  const reducedMotion = useSystemStore((s) => s.reducedMotion)
  const initDevice = useSystemStore((s) => s.initDevice)
  const quality = getQuality(tier)

  useEffect(() => {
    const profile = getDeviceProfile()
    initDevice({
      tier: profile.tier,
      renderer: profile.renderer,
      reducedMotion: profile.prefersReducedMotion,
      pinned: profile.pinned,
    })
  }, [initDevice])

  return (
    <Canvas
      // Cap DPR from the quality tier rather than letting R3F take the device's
      // native ratio — a 3x phone screen renders 9x the pixels of a 1x one.
      dpr={quality.dpr}
      shadows={quality.shadows}
      camera={{ position: [0, 0.6, 9.5], fov: 42, near: 0.1, far: 120 }}
      gl={{
        antialias: false, // The composer's multisampling handles this; both is waste.
        alpha: false,
        powerPreference: 'high-performance',
        // Guarantees a readable framebuffer for the Playwright pixel assertions.
        preserveDrawingBuffer: true,
      }}
      onCreated={({ gl, scene }) => {
        // ACES is what makes emissive highlights roll off instead of clipping to
        // flat white — essential for glass and bloom to read as light.
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = 1.15
        gl.outputColorSpace = THREE.SRGBColorSpace
        scene.matrixWorldAutoUpdate = true
      }}
    >
      <Suspense fallback={null}>
        <CameraRig reducedMotion={reducedMotion} />
        <Environment quality={quality} reducedMotion={reducedMotion} />
        <Carousel quality={quality} reducedMotion={reducedMotion} />
        <HandCursors />
        <EffectStack quality={quality} />
        <Preload all />
      </Suspense>

      <PerformanceGovernor />
      {/* Trims resolution during heavy frames; the governor handles the
          structural quality decisions on a longer horizon. */}
      <AdaptiveDpr pixelated={false} />
    </Canvas>
  )
}
