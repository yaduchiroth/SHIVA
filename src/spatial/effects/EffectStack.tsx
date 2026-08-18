'use client'

import { useMemo } from 'react'
import {
  Bloom,
  ChromaticAberration,
  EffectComposer,
  GodRays,
  Noise,
  Vignette,
} from '@react-three/postprocessing'
import { BlendFunction, KernelSize } from 'postprocessing'
import * as THREE from 'three'
import type { QualitySettings } from '@/core/config/quality'

/**
 * The post chain.
 *
 * Effects are unmounted rather than disabled on lower tiers; a disabled pass
 * still costs a full-screen copy through the composer.
 *
 * **There is deliberately no depth of field.** There was, focused on the front
 * carousel panel at 6.9 units, and it was correct for the scene it was written
 * for. Then the orb arrived at the origin — 11.5 units from the camera, 4.6
 * behind the focus plane — and with a `focalLength` of 0.045 that put the
 * avatar at roughly 93% circle of confusion. The single thing you most want to
 * look at was rendered almost entirely blurred, and reported, accurately, as
 * "everything appears blurred".
 *
 * It is gone rather than refocused, because refocusing only moves the problem.
 * This is an instrument: every object in the room is something you might reach
 * for, read, or drag to another monitor, and an effect whose entire purpose is
 * to make most of the frame unreadable is working against that. Photographs
 * have a subject. This does not.
 */

interface Props {
  quality: QualitySettings
  /** The mesh god rays radiate from; null until the scene has mounted it. */
  sun: THREE.Mesh | null
}

export function EffectStack({ quality, sun }: Props) {
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
          the render reads as too clean to be photographic.

          0.28 was too much. Grain is per-pixel noise, so it costs detail
          wherever detail is finest: the orb's synapse lines are one to two
          pixels wide and the panel type is barely more, and at that scale a
          soft-light dither reads as softness rather than as texture. 0.09 is
          still visible on the flat background — which is the only place it was
          ever doing anything — without eating the thin work. */}
      <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.09} />

      <Vignette eskil={false} offset={0.22} darkness={0.72} />
    </EffectComposer>
  )
}
