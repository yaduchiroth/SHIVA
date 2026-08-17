'use client'

import { useMemo } from 'react'
import {
  Bloom,
  ChromaticAberration,
  DepthOfField,
  EffectComposer,
  GodRays,
  Noise,
  Vignette,
} from '@react-three/postprocessing'
import { BlendFunction, KernelSize } from 'postprocessing'
import * as THREE from 'three'
import type { QualitySettings } from '@/core/config/quality'
import { useSpatialStore } from '@/core/store/useSpatialStore'

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

/**
 * Where the front panel sits, as a fraction of the camera's near/far range.
 *
 * Both values are derived, not guessed: the ring radius and the camera's
 * resting/focused positions are the only inputs, and `far` is 120 (see Stage).
 *   rest    — camera 11.5, panel at radius 4.6      → 6.9 units
 *   focused — camera 10.3, panel at radius 4.6*1.08 → 5.3 units
 */
const FOCUS_AT_REST = 6.9 / 120
const FOCUS_WHEN_FOCUSED = 5.3 / 120

interface Props {
  quality: QualitySettings
  /** The mesh god rays radiate from; null until the scene has mounted it. */
  sun: THREE.Mesh | null
}

export function EffectStack({ quality, sun }: Props) {
  const focused = useSpatialStore((s) => s.focused)
  const focusDistance = focused !== null ? FOCUS_WHEN_FOCUSED : FOCUS_AT_REST

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
      {/* God rays first: they read the scene's occlusion, so they must run
          before anything blurs or displaces what they're sampling. Mounted only
          once the sun mesh exists — the effect constructs against it. */}
      {quality.godRays && sun ? (
        <GodRays
          sun={sun}
          samples={40}
          density={0.96}
          decay={0.93}
          // Raised to compensate for a much smaller emitter. The pass scales
          // its output by how much light it finds along each ray, so shrinking
          // the source from a sixth of the frame to under a degree removed
          // almost all of it — the shafts were faint before precisely because
          // the ball was doing the work instead.
          weight={0.52}
          exposure={0.46}
          clampMax={1}
          // Half-res with a wide kernel: shafts are inherently soft, so paying
          // for full resolution buys nothing visible.
          resolutionScale={0.5}
          kernelSize={KernelSize.MEDIUM}
          blur
        />
      ) : (
        <></>
      )}

      {quality.depthOfField ? (
        <DepthOfField
          // Tracks the subject rather than being a constant. Focus must land ON
          // the front panel — miss it and the very text the panel exists to
          // display goes soft — and the panel sits at a different distance when
          // focused than at rest, so one fixed value cannot serve both states.
          focusDistance={focusDistance}
          focalLength={0.045}
          // Enough separation to push the rear of the ring back without turning
          // the neighbouring panels into unreadable smears.
          bokehScale={2.2}
          height={480}
        />
      ) : (
        <></>
      )}

      {quality.bloom ? (
        <Bloom
          // Tuned against how dark this scene actually is. At 1.0 nothing ever
          // crossed the threshold and bloom was inert — the accent bars, panel
          // titles and emissive rims all sit below full white. 0.8 catches
          // exactly those elements while leaving the near-black background and
          // mid-grey chrome untouched, which is the line between "lit" and "the
          // whole frame hazes over".
          luminanceThreshold={0.8}
          luminanceSmoothing={0.25}
          intensity={1.1}
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
