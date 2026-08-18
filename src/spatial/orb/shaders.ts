import * as THREE from 'three'
import { MAX_PULSES, PULSE_LIFE, PULSE_SPEED, orbDrive } from './orbDrive'

/**
 * GLSL shared by every layer that reacts to a pulse.
 *
 * A pulse is an expanding spherical wavefront from a point, and the whole
 * effect is four vec3s and four floats — no buffers, no per-frame CPU work, no
 * traversal of the synapse graph. That is the reason it is done this way rather
 * than by walking the network on the CPU and writing per-node activations:
 * lighting 600 nodes and 1,200 edges from a pinch costs the same as lighting
 * none of them.
 *
 * The cost of the approximation is that the wave ignores the graph — it travels
 * through space, not along edges. At these densities the two are visually
 * indistinguishable, because the edges themselves are short and local.
 */
export const PULSE_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uPulseOrigin[${MAX_PULSES}];
uniform float uPulseTime[${MAX_PULSES}];
uniform float uPulseSpeed;
uniform float uPulseLife;

/** 0 at rest, rising to ~1 as a wavefront sweeps past the given point. */
float pulseAt(vec3 p) {
  float acc = 0.0;
  for (int i = 0; i < ${MAX_PULSES}; i++) {
    float age = uTime - uPulseTime[i];
    if (age < 0.0 || age > uPulseLife) continue;
    float front = age * uPulseSpeed;
    // Thickness of the front. Too thin and it strobes between nodes at low
    // counts; too thick and the whole orb flashes at once instead of a wave
    // visibly travelling across it.
    float d = abs(length(p - uPulseOrigin[i]) - front);
    float ring = 1.0 - smoothstep(0.0, 0.42, d);
    // Fades over its life, so a pulse dies out rather than reaching the far
    // side of the orb at full strength.
    acc += ring * (1.0 - age / uPulseLife);
  }
  return min(acc, 1.6);
}
`

export interface PulseUniforms {
  uTime: { value: number }
  uPulseOrigin: { value: THREE.Vector3[] }
  uPulseTime: { value: Float32Array }
  uPulseSpeed: { value: number }
  uPulseLife: { value: number }
}

/** A fresh pulse uniform block. Every material needs its own — see below. */
export const pulseUniforms = (): PulseUniforms => ({
  uTime: { value: 0 },
  // Fresh arrays per material. Sharing one would point every layer's uniform
  // at the same memory, which works right up until one material is disposed
  // and takes the others' state with it.
  uPulseOrigin: { value: Array.from({ length: MAX_PULSES }, () => new THREE.Vector3()) },
  uPulseTime: { value: new Float32Array(MAX_PULSES).fill(-1000) },
  uPulseSpeed: { value: PULSE_SPEED },
  uPulseLife: { value: PULSE_LIFE },
})

/**
 * Copies the current drive state into a material's uniforms. Call once per
 * frame per pulse-aware material.
 *
 * Values are written INTO the existing objects rather than replacing them.
 * three captures the object it was handed when the program was compiled and
 * reads through that reference on every draw, so assigning a new array here
 * would silently stop the uniform ever updating again — a bug that presents as
 * "the shader ignores my state" with nothing in any log.
 */
export function syncPulseUniforms(u: PulseUniforms): void {
  u.uTime.value = orbDrive.time
  const origins = u.uPulseOrigin.value
  for (let i = 0; i < origins.length; i++) {
    origins[i]!.set(
      orbDrive.pulseOrigins[i * 3]!,
      orbDrive.pulseOrigins[i * 3 + 1]!,
      orbDrive.pulseOrigins[i * 3 + 2]!,
    )
  }
  u.uPulseTime.value.set(orbDrive.pulseTimes)
}

/**
 * Softens a square point sprite into a round one with a bright centre.
 *
 * Without it every "neuron" is a literal square, which is the single most
 * obvious tell that a particle system is untextured — and it costs two
 * instructions instead of a texture fetch.
 */
export const POINT_FALLOFF_GLSL = /* glsl */ `
float pointFalloff() {
  float d = length(gl_PointCoord - vec2(0.5));
  if (d > 0.5) discard;
  return pow(1.0 - d * 2.0, 1.8);
}
`
