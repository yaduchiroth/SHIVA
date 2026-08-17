'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * Volumetric fog as layered billboards.
 *
 * True raymarched volumetrics look better but cost a full-screen march per
 * frame, which is unaffordable alongside transmission glass and a neural net.
 * Layered soft-noise planes drifting at different speeds and depths produce the
 * parallax that reads as "volume" for a fraction of the cost — an old trick,
 * still the right one at this budget.
 *
 * The noise is generated once into a texture rather than evaluated per-pixel
 * per-frame; animation comes from moving UVs, not from re-noising.
 */

const LAYERS = 7

function createNoiseTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)

  // Value noise summed over octaves. Smooth interpolation matters here: raw
  // per-pixel random reads as television static, not vapour.
  const lattice = new Float32Array((size + 1) * (size + 1))
  for (let i = 0; i < lattice.length; i++) lattice[i] = Math.random()

  const sample = (x: number, y: number, freq: number): number => {
    const fx = (x * freq) % size
    const fy = (y * freq) % size
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    // Smoothstep the interpolants — bilinear alone leaves visible lattice creases.
    const sx = tx * tx * (3 - 2 * tx)
    const sy = ty * ty * (3 - 2 * ty)
    const idx = (xx: number, yy: number) => lattice[(yy % size) * (size + 1) + (xx % size)]!
    const a = idx(x0, y0)
    const b = idx(x0 + 1, y0)
    const c = idx(x0, y0 + 1)
    const d = idx(x0 + 1, y0 + 1)
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0
      let amp = 0.5
      let freq = 0.02
      for (let o = 0; o < 4; o++) {
        v += sample(x, y, freq) * amp
        amp *= 0.5
        freq *= 2.1
      }
      // Bias dark: fog should be an occasional lift in the frame, not a wash.
      v = Math.pow(Math.min(1, v), 1.8)

      // Radial falloff so each billboard fades at its own edges and the quad
      // boundary never becomes visible.
      const dx = (x / size - 0.5) * 2
      const dy = (y / size - 0.5) * 2
      const falloff = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy))

      const i = (y * size + x) * 4
      const c = Math.round(255 * v)
      data[i] = c
      data[i + 1] = c
      data[i + 2] = c
      data[i + 3] = Math.round(255 * v * falloff * falloff)
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

interface Props {
  density: number
  color?: string
}

export function VolumetricFog({ density, color = '#3d4560' }: Props) {
  const group = useRef<THREE.Group>(null)

  // Textures are created once and owned by the layer that animates them. Each
  // layer needs its own instance because UV offset lives on the texture —
  // sharing one would lock every layer to the same drift and collapse the
  // parallax that makes this read as volume.
  const layers = useMemo(() => {
    const source = createNoiseTexture(256)
    return Array.from({ length: LAYERS }, (_, i) => {
      const t = i / (LAYERS - 1)
      return {
        texture: i === 0 ? source : source.clone(),
        z: -22 + t * 30,
        scale: 34 - t * 12,
        // Distant layers drift slower — the parallax cue that implies depth.
        speed: 0.008 + t * 0.022,
        rotation: Math.random() * Math.PI * 2,
        opacity: (0.16 + t * 0.24) * density * 14,
        offset: Math.random() * 100,
      }
    })
  }, [density])

  // Textures cloned above are not owned by R3F's reconciler, so nothing else
  // will free them when the density prop changes or the scene unmounts.
  useEffect(() => () => layers.forEach((l) => l.texture.dispose()), [layers])

  useFrame((state) => {
    if (!group.current) return
    const t = state.clock.elapsedTime
    group.current.children.forEach((child, i) => {
      const layer = layers[i]
      if (!layer) return
      const mesh = child as THREE.Mesh
      const mat = mesh.material as THREE.MeshBasicMaterial
      if (mat.map) {
        mat.map.offset.x = (t * layer.speed + layer.offset) % 1
        mat.map.offset.y = Math.sin(t * layer.speed * 0.6 + layer.offset) * 0.1
      }
      // A slow counter-rotation stops the drift from reading as a flat pan.
      mesh.rotation.z = layer.rotation + t * layer.speed * 0.12
    })
  })

  return (
    <group ref={group}>
      {layers.map((layer, i) => (
        <mesh key={i} position={[0, 0, layer.z]} rotation={[0, 0, layer.rotation]}>
          <planeGeometry args={[layer.scale, layer.scale]} />
          <meshBasicMaterial
            map={layer.texture}
            transparent
            opacity={layer.opacity}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            color={color}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  )
}
