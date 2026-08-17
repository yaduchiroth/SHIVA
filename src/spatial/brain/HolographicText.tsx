'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useBrainStore } from '@/core/store/useBrainStore'
import { PALETTE } from '@/core/config/palette'

/**
 * SHIVA's replies, assembled from particles.
 *
 * Target positions are sampled from a Canvas2D render of the text: draw the
 * glyphs, read the pixels, keep the covered ones. That gives exact letterforms
 * from any locally-installed font with no glyph geometry, no typeface asset,
 * and no CDN — the same reasoning as the panel faces.
 *
 * All motion is on the GPU. Each particle stores where it starts and where it
 * belongs; the vertex shader interpolates with a per-particle delay so the text
 * coalesces raggedly rather than snapping into place in lockstep. Only a single
 * uniform changes per frame.
 *
 * Re-sampling is throttled rather than run per token: rebuilding target
 * positions is a canvas read, which is far too expensive to do at streaming
 * rate.
 */

const MAX_PARTICLES = 2600
const CANVAS_W = 1024
const CANVAS_H = 256
/**
 * World size of the text plane.
 *
 * Bounded by what the camera actually frames: at the resting camera position a
 * plane 2.4 units forward sees roughly 7 world units of height centred just
 * above the origin. Three lines at this size sit inside that; larger and the
 * top line is cropped by the frame edge.
 */
const PLANE_W = 6.6
const PLANE_H = 1.6

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uProgress;
  uniform float uPixelRatio;
  attribute vec3 aTarget;
  attribute vec3 aScatter;
  attribute float aDelay;
  attribute float aActive;
  varying float vAlpha;

  void main() {
    // Per-particle delay staggers the assembly so it reads as a swarm settling
    // rather than one rigid object moving.
    float t = clamp((uProgress - aDelay) / (1.0 - aDelay + 0.001), 0.0, 1.0);
    // Smootherstep: eases in and out with zero acceleration at both ends.
    t = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);

    vec3 drift = vec3(
      sin(uTime * 0.7 + aDelay * 12.0) * 0.02,
      cos(uTime * 0.9 + aDelay * 8.0) * 0.02,
      sin(uTime * 0.5 + aDelay * 5.0) * 0.03
    );

    // Unassigned particles stay scattered and invisible rather than collapsing
    // to the origin, which would show as a bright knot in the middle.
    vec3 pos = mix(aScatter, aTarget + drift, t * aActive);

    vec4 viewPos = viewMatrix * modelMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * viewPos;
    gl_PointSize = (2.6 * uPixelRatio) * (10.0 / -viewPos.z);

    // Brightest just as it lands, then settling back — the visual equivalent of
    // a word arriving.
    float landing = smoothstep(0.6, 1.0, t) * 0.5;
    vAlpha = aActive * t * (0.55 + landing);
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float falloff = 1.0 - smoothstep(0.0, 0.5, d);
    gl_FragColor = vec4(uColor, falloff * vAlpha);
  }
`

/** Samples glyph coverage and returns world-space target positions. */
function sampleText(text: string): Float32Array {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return new Float32Array(0)

  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // Wrap to at most three lines, shrinking to fit rather than overflowing.
  const words = text.split(/\s+/)
  let fontSize = 60
  let lines: string[] = []

  for (; fontSize >= 26; fontSize -= 4) {
    ctx.font = `500 ${fontSize}px ui-monospace, "SF Mono", Menlo, monospace`
    lines = []
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (ctx.measureText(candidate).width > CANVAS_W - 60 && line) {
        lines.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    if (line) lines.push(line)
    if (lines.length <= 3) break
  }

  // Past the smallest size, truncate rather than shrink into illegibility.
  if (lines.length > 3) {
    lines = lines.slice(0, 3)
    lines[2] = `${lines[2]!.slice(0, -1)}…`
  }

  const lineHeight = fontSize * 1.25
  const startY = CANVAS_H / 2 - ((lines.length - 1) * lineHeight) / 2
  lines.forEach((line, i) => ctx.fillText(line, CANVAS_W / 2, startY + i * lineHeight))

  const { data } = ctx.getImageData(0, 0, CANVAS_W, CANVAS_H)

  // Collect covered pixels on a stride, then thin down to the budget. Sampling
  // every pixel would find far more than the particle count and bias the result
  // toward whatever the scan reached first — which is the top-left of the text.
  const covered: [number, number][] = []
  const stride = 3
  for (let y = 0; y < CANVAS_H; y += stride) {
    for (let x = 0; x < CANVAS_W; x += stride) {
      if (data[(y * CANVAS_W + x) * 4 + 3]! > 128) covered.push([x, y])
    }
  }
  if (covered.length === 0) return new Float32Array(0)

  const count = Math.min(covered.length, MAX_PARTICLES)
  const step = covered.length / count
  const targets = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const [x, y] = covered[Math.floor(i * step)]!
    targets[i * 3] = (x / CANVAS_W - 0.5) * PLANE_W
    targets[i * 3 + 1] = -(y / CANVAS_H - 0.5) * PLANE_H
    // Slight depth scatter so the text has thickness under depth of field.
    targets[i * 3 + 2] = (Math.random() - 0.5) * 0.06
  }
  return targets
}

export function HolographicText() {
  const material = useRef<THREE.ShaderMaterial>(null)
  const camera = useThree((s) => s.camera)
  const group = useRef<THREE.Group>(null)

  const streaming = useBrainStore((s) => s.streaming)
  const phase = useBrainStore((s) => s.phase)
  const transcript = useBrainStore((s) => s.transcript)
  const error = useBrainStore((s) => s.error)

  // What to render: an error, the reply as it streams, or the live transcript.
  const text = error ?? (streaming || (phase === 'listening' && transcript ? transcript : '')) ?? ''

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    const target = new Float32Array(MAX_PARTICLES * 3)
    const scatter = new Float32Array(MAX_PARTICLES * 3)
    const delay = new Float32Array(MAX_PARTICLES)
    const active = new Float32Array(MAX_PARTICLES)

    for (let i = 0; i < MAX_PARTICLES; i++) {
      // Scattered starting cloud, wider than the text so particles converge
      // inward from outside the letterforms.
      scatter[i * 3] = (Math.random() - 0.5) * PLANE_W * 2.2
      scatter[i * 3 + 1] = (Math.random() - 0.5) * PLANE_H * 3
      scatter[i * 3 + 2] = (Math.random() - 0.5) * 2.5
      delay[i] = Math.random() * 0.45
    }

    geo.setAttribute('position', new THREE.BufferAttribute(scatter.slice(), 3))
    geo.setAttribute('aTarget', new THREE.BufferAttribute(target, 3))
    geo.setAttribute('aScatter', new THREE.BufferAttribute(scatter, 3))
    geo.setAttribute('aDelay', new THREE.BufferAttribute(delay, 1))
    geo.setAttribute('aActive', new THREE.BufferAttribute(active, 1))
    // The shader displaces well beyond the authored bounds, so an explicit
    // sphere stops three culling the whole thing at oblique angles.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8)
    return geo
  }, [])

  useEffect(() => () => geometry.dispose(), [geometry])

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uPixelRatio: { value: 1 },
      uColor: { value: new THREE.Color(PALETTE.signal) },
    }),
    [],
  )

  // Re-sample on a throttle. Tokens arrive several times a second and each
  // re-sample is a full canvas read-back.
  const lastSampled = useRef(0)
  const pendingText = useRef('')
  pendingText.current = text

  useEffect(() => {
    if (error) uniforms.uColor.value.set(PALETTE.critical)
    else if (phase === 'listening') uniforms.uColor.value.set(PALETTE.tracking)
    else uniforms.uColor.value.set(PALETTE.signal)
  }, [error, phase, uniforms])

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1)
    if (material.current) {
      material.current.uniforms.uTime!.value = state.clock.elapsedTime
      material.current.uniforms.uPixelRatio!.value = state.viewport.dpr
    }

    const now = state.clock.elapsedTime
    const current = pendingText.current

    if (now - lastSampled.current > 0.25) {
      lastSampled.current = now
      const targets = sampleText(current)
      const targetAttr = geometry.attributes.aTarget as THREE.BufferAttribute
      const activeAttr = geometry.attributes.aActive as THREE.BufferAttribute
      const count = targets.length / 3

      for (let i = 0; i < MAX_PARTICLES; i++) {
        if (i < count) {
          targetAttr.array[i * 3] = targets[i * 3]!
          targetAttr.array[i * 3 + 1] = targets[i * 3 + 1]!
          targetAttr.array[i * 3 + 2] = targets[i * 3 + 2]!
          activeAttr.array[i] = 1
        } else {
          activeAttr.array[i] = 0
        }
      }
      targetAttr.needsUpdate = true
      activeAttr.needsUpdate = true
    }

    // Progress drives assembly and dispersal — the same uniform in reverse.
    if (material.current) {
      const wanted = current.length > 0 ? 1 : 0
      const u = material.current.uniforms.uProgress!
      u.value += (wanted - u.value) * Math.min(1, dt * (wanted ? 3.5 : 2))
    }

    // Face the camera, floating above the carousel.
    if (group.current) {
      group.current.quaternion.copy(camera.quaternion)
    }
  })

  return (
    // Forward of the ring, not level with it: at the ring's own depth the
    // lower lines are occluded by the front panel, which silently truncates
    // longer replies.
    <group ref={group} position={[0, 2.7, 2.4]}>
      <points geometry={geometry} frustumCulled={false}>
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
    </group>
  )
}
