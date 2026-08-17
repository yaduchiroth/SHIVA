'use client'

import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * A procedurally generated studio environment.
 *
 * Transmission glass is *only* as interesting as what it has to refract. With no
 * environment, `transmission: 1` in an empty dark scene renders the panels
 * essentially invisible: you see straight through them to the background, there
 * are no specular highlights on the bevels, and the whole carousel disappears.
 * That is what was happening.
 *
 * The obvious fix — drei's `<Environment preset>` — fetches an HDR from a CDN at
 * runtime. That breaks offline, and the COEP header this app sets would block
 * the cross-origin request anyway. So the environment is built here instead:
 *
 *   - A float texture, not a canvas. Canvas2D is 8-bit and clamps at 1.0, which
 *     gives flat grey reflections and never crosses the bloom threshold. Float
 *     data lets the softboxes sit at ~8.0, so they read as actual light sources
 *     and bloom the way real highlights do.
 *   - Equirectangular layout, run through `PMREMGenerator` to produce the
 *     prefiltered mipmapped radiance map that physical materials sample for
 *     roughness-correct reflections.
 *
 * The layout is a conventional three-point studio: a broad key softbox high on
 * one side, a cooler fill opposite, and a warm low kicker to keep the underside
 * of the glass from going dead.
 */

const WIDTH = 512
const HEIGHT = 256

function buildEquirect(): THREE.DataTexture {
  const data = new Float32Array(WIDTH * HEIGHT * 4)

  /** Adds a soft elliptical light. u/v and radii are in 0..1 equirect space. */
  const softbox = (
    u0: number,
    v0: number,
    ru: number,
    rv: number,
    intensity: number,
    color: [number, number, number],
  ) => {
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const u = x / WIDTH
        const v = y / HEIGHT

        // Wrap horizontally so a light crossing the seam stays continuous.
        let du = Math.abs(u - u0)
        if (du > 0.5) du = 1 - du
        const dv = v - v0

        const d = Math.hypot(du / ru, dv / rv)
        if (d >= 1) continue

        // Smooth falloff, squared for a softer core-to-edge ramp.
        const falloff = (1 - d) * (1 - d)
        const i = (y * WIDTH + x) * 4
        // Lights accumulate additively, so each channel is read back before
        // being written — hence the explicit reads rather than `+=`.
        data[i] = data[i]! + color[0]! * intensity * falloff
        data[i + 1] = data[i + 1]! + color[1]! * intensity * falloff
        data[i + 2] = data[i + 2]! + color[2]! * intensity * falloff
      }
    }
  }

  // Base gradient. v=0 is up. Cool overhead, near-black underfoot, so the glass
  // picks up a vertical tonal ramp instead of a uniform wash.
  for (let y = 0; y < HEIGHT; y++) {
    const v = y / HEIGHT
    // Horizon sits at v=0.5; below it falls away fast, as a real floor does.
    const sky = Math.pow(1 - v, 1.4) * 0.35
    const floor = v > 0.5 ? Math.pow((v - 0.5) * 2, 2) * 0.04 : 0
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4
      data[i] = sky * 0.62 + floor * 0.9
      data[i + 1] = sky * 0.72 + floor * 0.8
      data[i + 2] = sky * 1.0 + floor * 0.75
      data[i + 3] = 1
    }
  }

  // Key: broad, high, slightly cool — the source of the main bevel highlight.
  softbox(0.16, 0.22, 0.13, 0.16, 9, [0.86, 0.92, 1.0])
  // Fill: opposite side, dimmer and cooler still, to shape the far edge.
  softbox(0.66, 0.3, 0.16, 0.2, 3.2, [0.62, 0.72, 1.0])
  // Kicker: low and warm, so the underside of the glass isn't dead.
  softbox(0.44, 0.68, 0.2, 0.12, 1.8, [1.0, 0.72, 0.45])
  // A narrow overhead strip reads as a ceiling light and gives the top bevel a
  // crisp linear glint — the detail that makes glass look manufactured.
  softbox(0.9, 0.08, 0.35, 0.05, 5, [1.0, 0.98, 0.94])

  const texture = new THREE.DataTexture(data, WIDTH, HEIGHT, THREE.RGBAFormat, THREE.FloatType)
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

export function StudioEnvironment({ intensity = 1 }: { intensity?: number }) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)

  const envMap = useMemo(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    // Compiling the equirect shader up front avoids a hitch on first use.
    pmrem.compileEquirectangularShader()

    const equirect = buildEquirect()
    const target = pmrem.fromEquirectangular(equirect)

    // The source texture and the generator are both done once the prefiltered
    // target exists; only the target's texture is needed from here.
    equirect.dispose()
    pmrem.dispose()
    return target.texture
  }, [gl])

  useEffect(() => {
    scene.environment = envMap
    scene.environmentIntensity = intensity
    // Deliberately NOT set as scene.background: the void behind the carousel is
    // part of the aesthetic. The environment is for reflection and refraction
    // only, which is exactly what an unseen studio does for a product shot.
    return () => {
      scene.environment = null
    }
  }, [scene, envMap, intensity])

  useEffect(() => () => envMap.dispose(), [envMap])

  return null
}
