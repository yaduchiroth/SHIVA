'use client'

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * The ground plane.
 *
 * Rendered as a shader rather than line geometry for two reasons: it stays
 * pixel-crisp at any distance (geometry-based grids alias badly at grazing
 * angles), and it can fade to nothing at the horizon, which is what makes the
 * space read as infinite rather than as a large flat card.
 */

const vertexShader = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform vec3 uAccent;
  uniform float uFade;
  varying vec3 vWorld;

  // Analytic anti-aliasing: derivatives give the line a constant apparent
  // width in screen space no matter how oblique the view angle.
  float grid(vec2 coord, float spacing, float thickness) {
    vec2 g = abs(fract(coord / spacing - 0.5) - 0.5) / fwidth(coord / spacing);
    return 1.0 - min(min(g.x, g.y) / thickness, 1.0);
  }

  void main() {
    vec2 p = vWorld.xz;

    float fine = grid(p, 1.0, 1.0) * 0.25;
    float coarse = grid(p, 5.0, 1.4) * 0.5;

    float dist = length(p);
    float fade = 1.0 - smoothstep(0.0, uFade, dist);

    // A slow pulse travelling outward keeps the floor alive without motion
    // that competes for attention with the carousel.
    float pulse = sin(dist * 0.45 - uTime * 0.8) * 0.5 + 0.5;
    pulse = pow(pulse, 8.0) * 0.35;

    float line = max(fine, coarse);
    vec3 color = mix(uColor, uAccent, coarse * 0.5 + pulse);
    float alpha = (line + coarse * pulse) * fade * fade;

    if (alpha < 0.002) discard;
    gl_FragColor = vec4(color, alpha);
  }
`

interface Props {
  color?: string
  accent?: string
  fadeDistance?: number
}

export function InfiniteGrid({
  color = '#2a2a31',
  accent = '#7c9cff',
  fadeDistance = 42,
}: Props) {
  const material = useRef<THREE.ShaderMaterial>(null)

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uAccent: { value: new THREE.Color(accent) },
      uFade: { value: fadeDistance },
    }),
    [color, accent, fadeDistance],
  )

  useFrame((state) => {
    if (material.current) material.current.uniforms.uTime!.value = state.clock.elapsedTime
  })

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -3.2, 0]}>
      <planeGeometry args={[140, 140]} />
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        // Without this the grid occludes the fog billboards drifting above it.
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}
