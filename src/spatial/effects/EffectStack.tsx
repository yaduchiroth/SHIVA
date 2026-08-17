'use client'

import { useMemo } from 'react'
import {
  Bloom,
  ChromaticAberration,
  DepthOfField,
  EffectComposer,
  Noise,
  Vignette,
} from '@react-three/postprocessing'
import { BlendFunction, KernelSize } from 'postprocessing'
import * as THREE from 'three'
import type { QualitySettings } from '@/core/config/quality'

/**
 * The post chain.
 *
 * Order matters and is not arbitrary: depth of field runs before bloom so that
 * out-of-focus highlights bloom as the soft discs they've become rather than as
 * the sharp points they were. Grain goes last so it isn't itself blurred —
 * film grain that respects depth of field looks like a rendering artifact.
 *
 * Effects are unmounted rather than disabled on lower tiers; a disabled pass
 * still costs a full-screen copy through the composer.
 */

interface Props {
  quality: QualitySettings
}

export function EffectStack({ quality }: Props) {
  // Effect constructors read these once, so a fresh Vector2 per render would
  // recreate the pass on every parent render.
  const aberrationOffset = useMemo(() => new THREE.Vector2(0.0004, 0.0006), [])

  return (
    <EffectComposer
      // HDR buffers give bloom real highlight range instead of clipping at white.
      frameBufferType={THREE.HalfFloatType}
      multisampling={quality.shadows ? 4 : 0}
      enableNormalPass={false}
    >
      {quality.depthOfField ? (
        <DepthOfField
          // Focus sits on the carousel ring, not the origin — the front panel is
          // what the eye lands on.
          focusDistance={0.018}
          focalLength={0.05}
          bokehScale={3.5}
          height={480}
        />
      ) : (
        <></>
      )}

      {quality.bloom ? (
        <Bloom
          // Above 1.0 only genuine highlights bloom — emissive edges and specular
          // hits on the glass. Lower and the entire frame hazes over.
          luminanceThreshold={1.0}
          luminanceSmoothing={0.3}
          intensity={0.85}
          kernelSize={quality.godRays ? KernelSize.LARGE : KernelSize.MEDIUM}
          mipmapBlur
        />
      ) : (
        <></>
      )}

      {/* Only `offset` is passed. The effect also supports `radialModulation`,
          which would confine fringing to the frame edges as real glass does,
          but drei's prop type erases every key except offset/ref: the wrapped
          constructor's parameter is optional, so `Partial<Options | undefined>`
          collapses to nothing. Not worth a cast — the offset is deliberately
          subtle enough that uniform application reads fine. */}
      {quality.chromaticAberration ? <ChromaticAberration offset={aberrationOffset} /> : <></>}

      {/* Grain ties the synthetic elements to a common noise floor — without it
          the render reads as too clean to be photographic. */}
      <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.28} />

      <Vignette eskil={false} offset={0.22} darkness={0.72} />
    </EffectComposer>
  )
}
