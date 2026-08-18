'use client'

import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { OrbBudget } from '@/core/config/quality'
import { buildNeurons } from './geometry'
import { orbDrive } from './orbDrive'
import { PULSE_GLSL, POINT_FALLOFF_GLSL, pulseUniforms, syncPulseUniforms } from './shaders'

/**
 * The neurons: nodes on a shell, wired to their neighbours, lit by travelling
 * pulses.
 *
 * Nodes are `Points` rather than instanced spheres. At the size they render —
 * a couple of pixels — a sphere and a soft round point are indistinguishable,
 * and points need none of the instancing machinery: per-node values are plain
 * vertex attributes, and there is no matrix per node to build or upload.
 *
 * Both layers write no depth and blend additively, so they glow through the
 * shell around them instead of being clipped by it. Neither is sorted, which
 * is exactly what additive blending buys: order does not matter when the
 * operation is commutative.
 */

const NODE_VERT = /* glsl */ `
attribute float aPhase;
attribute float aScale;
uniform float uSize;
uniform float uEnergy;
varying float vPulse;
varying float vTwinkle;
${PULSE_GLSL}
void main() {
  vPulse = pulseAt(position);
  // Each node breathes on its own phase; without this the field pulses in
  // lockstep and reads as one object flickering rather than as many.
  vTwinkle = 0.55 + 0.45 * sin(uTime * 1.7 + aPhase);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = uSize * aScale * (1.0 + vPulse * 1.9 + uEnergy * 0.35);
  // Divide by view depth so points shrink with distance. Without it they are a
  // constant pixel size and the cloud looks painted onto the screen.
  gl_PointSize = size / max(0.001, -mv.z);
}
`

const NODE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uAccent;
uniform float uEnergy;
varying float vPulse;
varying float vTwinkle;
${POINT_FALLOFF_GLSL}
void main() {
  float a = pointFalloff();
  float lit = 0.25 + uEnergy * 0.4 + vPulse * 1.3;
  gl_FragColor = vec4(uAccent * lit * vTwinkle, 1.0) * a;
}
`

const EDGE_VERT = /* glsl */ `
attribute vec3 aMid;
varying float vPulse;
${PULSE_GLSL}
void main() {
  // Sampled at the edge's midpoint rather than at each endpoint, so an edge
  // lights as one thing. Per-endpoint sampling makes a wavefront appear to bend
  // every line it crosses, which reads as a geometry bug.
  vPulse = pulseAt(aMid);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const EDGE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uAccent;
uniform float uBase;
uniform float uEnergy;
varying float vPulse;
void main() {
  float lit = uBase + uEnergy * 0.09 + vPulse * 0.85;
  gl_FragColor = vec4(uAccent * lit, 1.0);
}
`

interface Props {
  budget: OrbBudget
  innerRadius: number
  outerRadius: number
  seed: number
}

export function NeuralNet({ budget, innerRadius, outerRadius, seed }: Props) {
  const built = useMemo(
    () =>
      buildNeurons({
        count: budget.neurons,
        synapses: budget.synapses,
        innerRadius,
        outerRadius,
        seed,
      }),
    [budget.neurons, budget.synapses, innerRadius, outerRadius, seed],
  )

  const nodeUniforms = useMemo(
    () => ({
      ...pulseUniforms(),
      uSize: { value: 190 },
      uEnergy: { value: 0.25 },
      uAccent: { value: new THREE.Color(1, 1, 1) },
    }),
    [],
  )

  const edgeUniforms = useMemo(
    () => ({
      ...pulseUniforms(),
      uBase: { value: 0.075 },
      uEnergy: { value: 0.25 },
      uAccent: { value: new THREE.Color(1, 1, 1) },
    }),
    [],
  )

  useFrame(() => {
    for (const u of [nodeUniforms, edgeUniforms]) {
      syncPulseUniforms(u)
      u.uEnergy.value = orbDrive.energy
      u.uAccent.value.setRGB(orbDrive.accent[0]!, orbDrive.accent[1]!, orbDrive.accent[2]!)
    }
    // No `needsUpdate` anywhere: uniform VALUES are read fresh on every draw.
    // That flag is for structural changes — a recompiled shader, a swapped
    // texture — and setting it per frame forces a needless program relink.
  })

  return (
    <group>
      <points frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[built.positions, 3]} />
          <bufferAttribute attach="attributes-aPhase" args={[built.phases, 1]} />
          <bufferAttribute attach="attributes-aScale" args={[built.scales, 1]} />
        </bufferGeometry>
        <shaderMaterial
          vertexShader={NODE_VERT}
          fragmentShader={NODE_FRAG}
          uniforms={nodeUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      <lineSegments frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[built.edgePositions, 3]} />
          <bufferAttribute attach="attributes-aMid" args={[built.edgeMidpoints, 3]} />
        </bufferGeometry>
        <shaderMaterial
          vertexShader={EDGE_VERT}
          fragmentShader={EDGE_FRAG}
          uniforms={edgeUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>
    </group>
  )
}
