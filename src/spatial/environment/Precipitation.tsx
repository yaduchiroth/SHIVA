'use client'

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Sky } from '@/core/store/useDataStore'

/**
 * Rain and snow, driven by the actual weather where you are.
 *
 * Falling entirely on the GPU: each drop's vertical position is
 * `fract(start - time * speed)`, which wraps by construction. That means no
 * per-frame JS, no respawn bookkeeping, and no buffer re-upload — the whole
 * field is one uniform update per frame regardless of how many particles it
 * contains.
 *
 * Rain and snow share a shader and differ only in constants, because they are
 * the same phenomenon with different drag: rain is fast, near-vertical and
 * stretched by motion; snow is slow, drifts sideways, and stays round.
 */

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uSpeed;
  uniform float uDrift;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uFallHeight;
  attribute float aOffset;
  attribute float aScale;
  varying float vAlpha;

  void main() {
    vec3 pos = position;

    // fract() wraps in [0,1) on its own, so a drop reaching the ground
    // reappears at the top with no branch and no CPU involvement.
    float fall = fract(aOffset - uTime * uSpeed);
    pos.y = (fall - 0.5) * uFallHeight;

    // Sideways drift, phase-shifted per particle. Snow uses a large value here
    // and rain almost none, which is most of what separates them visually.
    pos.x += sin(uTime * 0.6 + aOffset * 30.0) * uDrift;
    pos.z += cos(uTime * 0.5 + aOffset * 22.0) * uDrift;

    vec4 viewPos = viewMatrix * modelMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * viewPos;
    gl_PointSize = uSize * aScale * uPixelRatio * (14.0 / -viewPos.z);

    // Fade near the camera and at the far edge, so particles enter and leave
    // the frame rather than popping.
    float depth = -viewPos.z;
    vAlpha = smoothstep(1.5, 6.0, depth) * (1.0 - smoothstep(26.0, 44.0, depth));
    // And fade at the very bottom, standing in for hitting a surface.
    vAlpha *= smoothstep(0.0, 0.15, fall);
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStreak;
  varying float vAlpha;

  void main() {
    vec2 coord = gl_PointCoord - 0.5;
    // Squashing one axis stretches the point into a streak — motion blur for
    // rain, disabled for snow, without needing separate geometry.
    coord.y *= uStreak;
    float d = length(coord);
    if (d > 0.5) discard;
    gl_FragColor = vec4(uColor, (1.0 - smoothstep(0.0, 0.5, d)) * vAlpha);
  }
`

interface Props {
  sky: Sky
  /** Scales the particle count with the quality tier. */
  budget: number
}

/** Per-condition tuning. Absent keys mean no precipitation. */
const PROFILES: Partial<
  Record<
    Sky,
    { speed: number; drift: number; size: number; streak: number; color: string; density: number }
  >
> = {
  rain: { speed: 0.55, drift: 0.05, size: 1.6, streak: 6, color: '#9fb4d8', density: 1 },
  storm: { speed: 0.85, drift: 0.09, size: 2.0, streak: 8, color: '#b6c6e4', density: 1.6 },
  snow: { speed: 0.09, drift: 0.55, size: 3.2, streak: 1, color: '#e8eefc', density: 0.7 },
}

export function Precipitation({ sky, budget }: Props) {
  const profile = PROFILES[sky]
  const material = useRef<THREE.ShaderMaterial>(null)

  const count = Math.round((profile?.density ?? 0) * budget)

  const geometry = useMemo(() => {
    const positions = new Float32Array(count * 3)
    const offsets = new Float32Array(count)
    const scales = new Float32Array(count)

    for (let i = 0; i < count; i++) {
      // Cylindrical, centred on the viewer — precipitation belongs in the
      // volume you look through, not spread evenly across a box.
      const radius = Math.sqrt(Math.random()) * 22
      const theta = Math.random() * Math.PI * 2
      positions[i * 3] = Math.cos(theta) * radius
      positions[i * 3 + 1] = 0 // replaced by the shader every frame
      positions[i * 3 + 2] = Math.sin(theta) * radius
      offsets[i] = Math.random()
      scales[i] = 0.6 + Math.random() * 0.8
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('aOffset', new THREE.BufferAttribute(offsets, 1))
    geo.setAttribute('aScale', new THREE.BufferAttribute(scales, 1))
    // The shader moves points far outside their authored bounds; without an
    // explicit sphere three culls the whole field at some angles.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 40)
    return geo
  }, [count])

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uSpeed: { value: profile?.speed ?? 0 },
      uDrift: { value: profile?.drift ?? 0 },
      uSize: { value: profile?.size ?? 1 },
      uStreak: { value: profile?.streak ?? 1 },
      uPixelRatio: { value: 1 },
      uFallHeight: { value: 34 },
      uColor: { value: new THREE.Color(profile?.color ?? '#ffffff') },
    }),
    [profile],
  )

  useFrame((state) => {
    if (!material.current) return
    material.current.uniforms.uTime!.value = state.clock.elapsedTime
    material.current.uniforms.uPixelRatio!.value = state.viewport.dpr
  })

  if (!profile || count === 0) return null

  return (
    <points geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        // Additive for rain reads as wet light; snow is bright enough that
        // normal blending keeps it from blowing out against the fog.
        blending={sky === 'snow' ? THREE.NormalBlending : THREE.AdditiveBlending}
      />
    </points>
  )
}
