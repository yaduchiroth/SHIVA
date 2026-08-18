'use client'

import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { OrbBudget } from '@/core/config/quality'
import { buildProtons, type Rgb } from './geometry'
import { orbDrive } from './orbDrive'
import { HAND_GLSL, POINT_FALLOFF_GLSL, handUniforms, syncHandUniforms } from './shaders'

/**
 * Particles on inclined elliptical orbits — the atomic half of the avatar.
 *
 * Every orbit is evaluated in the vertex shader from `uTime` and five
 * per-particle constants. The reference implementation instead keeps a `Mesh`
 * per rock and rewrites all of their positions from JavaScript on every frame:
 * 250 objects, 250 draw calls, and a loop that runs 60 times a second forever.
 * Here the CPU touches this layer exactly once, at build time, and thereafter
 * uploads a single float.
 *
 * The attribute in `position` is NOT a position — it is [orbitRadius, speed,
 * phase], and the real position is derived from it. That is worth knowing
 * before reading the shader, and it is why frustum culling is off: three would
 * compute a bounding sphere from those numbers and cull the layer from angles
 * where it is plainly visible.
 */

const VERT = /* glsl */ `
attribute vec2 aTilt;
attribute float aScale;
attribute vec3 aColor;
uniform float uTime;
uniform float uSize;
uniform float uEnergy;
varying vec3 vColor;
${HAND_GLSL}
void main() {
  float orbitR = position.x;
  float speed = position.y;
  float phase = position.z;
  // Energy speeds the whole cloud up rather than brightening it, so a busy
  // SHIVA reads as agitated instead of merely lit.
  float a = uTime * speed * (0.7 + uEnergy * 0.9) + phase;

  // Two independent tilts turn what would be a flat disc of orbits into a
  // shell of them. The vertical term is deliberately not a clean ellipse — a
  // second, slower sine keeps orbits from all crossing the equator together.
  vec3 p = vec3(
    orbitR * cos(a) * cos(aTilt.x),
    orbitR * sin(aTilt.x) * sin(a * 0.8) + sin(a * 0.3 + aTilt.y) * 0.2,
    orbitR * sin(a) * cos(aTilt.y)
  );

  vColor = aColor;
  p = displaceByHands(p * apertureScale());
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * aScale / max(0.001, -mv.z);
}
`

const FRAG = /* glsl */ `
precision highp float;
uniform vec3 uAccent;
uniform float uEnergy;
varying vec3 vColor;
${POINT_FALLOFF_GLSL}
void main() {
  float a = pointFalloff();
  // Tinted toward the accent rather than replaced by it, so the cloud keeps
  // its own variation while still answering to the orb's mood.
  vec3 c = mix(vColor, vColor * uAccent * 1.6, 0.65);
  gl_FragColor = vec4(c * (0.75 + uEnergy * 0.5), 1.0) * a;
}
`

interface Props {
  budget: OrbBudget
  minRadius: number
  maxRadius: number
  hot: Rgb
  warm: Rgb
  seed: number
}

export function ProtonCloud({ budget, minRadius, maxRadius, hot, warm, seed }: Props) {
  const built = useMemo(
    () => buildProtons({ count: budget.protons, minRadius, maxRadius, hot, warm, seed }),
    [budget.protons, minRadius, maxRadius, hot, warm, seed],
  )

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      // 1.0: the outermost layer, so a two-handed spread throws the proton
      // cloud furthest — the orb visibly opening rather than merely growing.
      ...handUniforms(1),
      uSize: { value: 90 },
      uEnergy: { value: 0.25 },
      uAccent: { value: new THREE.Color(1, 1, 1) },
    }),
    [],
  )

  useFrame(() => {
    syncHandUniforms(uniforms)
    uniforms.uTime.value = orbDrive.time
    uniforms.uEnergy.value = orbDrive.energy
    uniforms.uAccent.value.setRGB(orbDrive.accent[0]!, orbDrive.accent[1]!, orbDrive.accent[2]!)
  })

  if (built.scales.length === 0) return null

  return (
    <points frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[built.orbits, 3]} />
        <bufferAttribute attach="attributes-aTilt" args={[built.tilts, 2]} />
        <bufferAttribute attach="attributes-aScale" args={[built.scales, 1]} />
        <bufferAttribute attach="attributes-aColor" args={[built.colors, 3]} />
      </bufferGeometry>
      <shaderMaterial
        vertexShader={VERT}
        fragmentShader={FRAG}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}
