'use client'

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * Suspended dust.
 *
 * The single cheapest thing that makes a 3D scene feel like a *place* rather
 * than objects floating in a void: motes catching the light give the empty
 * volume between camera and content something to occlude, so the eye reads
 * distance where before it read background.
 *
 * All motion happens on the GPU. Updating positions from JS would mean writing
 * a few thousand floats per frame and re-uploading the buffer — pointless when
 * the motion is a closed-form function of time.
 */

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  uniform float uPixelRatio;
  attribute float aScale;
  attribute float aSpeed;
  attribute float aPhase;
  varying float vAlpha;

  void main() {
    vec3 pos = position;

    // Slow convection, each mote on its own phase so the field never pulses
    // in unison.
    pos.y += sin(uTime * aSpeed + aPhase) * 0.9;
    pos.x += cos(uTime * aSpeed * 0.7 + aPhase) * 0.5;
    pos.z += sin(uTime * aSpeed * 0.5 + aPhase * 1.3) * 0.4;

    vec4 viewPos = viewMatrix * modelMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * viewPos;

    // Perspective-correct sizing, clamped so near motes don't become discs.
    gl_PointSize = min(uSize * aScale * uPixelRatio * (12.0 / -viewPos.z), 6.0 * uPixelRatio);

    // Fade at both extremes: nearby motes would otherwise smear across the lens,
    // distant ones would stipple into aliasing.
    float depth = -viewPos.z;
    vAlpha = smoothstep(1.0, 6.0, depth) * (1.0 - smoothstep(24.0, 44.0, depth));
    vAlpha *= 0.35 + sin(uTime * aSpeed * 2.0 + aPhase) * 0.25;
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;

  void main() {
    // Soft radial falloff — square points read as digital noise.
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float alpha = (1.0 - smoothstep(0.0, 0.5, d)) * vAlpha;
    gl_FragColor = vec4(uColor, alpha);
  }
`

interface Props {
  count: number
  color?: string
}

export function Particulate({ count, color = '#b4b4c0' }: Props) {
  const material = useRef<THREE.ShaderMaterial>(null)

  const geometry = useMemo(() => {
    const positions = new Float32Array(count * 3)
    const scales = new Float32Array(count)
    const speeds = new Float32Array(count)
    const phases = new Float32Array(count)

    for (let i = 0; i < count; i++) {
      // Cylindrical distribution around the carousel: dust belongs in the volume
      // the user looks through, not uniformly across a cube they never visit.
      const radius = 3 + Math.random() * 26
      const theta = Math.random() * Math.PI * 2
      positions[i * 3] = Math.cos(theta) * radius
      positions[i * 3 + 1] = (Math.random() - 0.35) * 18
      positions[i * 3 + 2] = Math.sin(theta) * radius

      scales[i] = 0.4 + Math.random() * 1.4
      speeds[i] = 0.08 + Math.random() * 0.3
      phases[i] = Math.random() * Math.PI * 2
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('aScale', new THREE.BufferAttribute(scales, 1))
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1))
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1))
    // The shader displaces points well outside their authored bounds; without a
    // manual bounding sphere three.js frustum-culls the whole field at angles
    // where it should still be visible.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 40)
    return geo
  }, [count])

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uSize: { value: 2.2 },
      uPixelRatio: { value: 1 },
      uColor: { value: new THREE.Color(color) },
    }),
    [color],
  )

  useFrame((state) => {
    if (!material.current) return
    material.current.uniforms.uTime!.value = state.clock.elapsedTime
    material.current.uniforms.uPixelRatio!.value = state.viewport.dpr
  })

  return (
    <points geometry={geometry}>
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}
