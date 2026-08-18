'use client'

import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { OrbBudget } from '@/core/config/quality'
import { buildGlyphs } from './geometry'
import { buildGlyphAtlas, CELL_H, CELL_W } from './glyphAtlas'
import { orbDrive } from './orbDrive'

/**
 * Drifting machine chatter, as one instanced quad reading one atlas.
 *
 * This is the layer that makes the orb feel like it is computing rather than
 * merely spinning, and it is also the layer that would sink the frame budget if
 * built the obvious way. The reference implementation creates 1,700 `Sprite`s,
 * each with a freshly drawn 256x32 canvas: 1,700 textures, 1,700 draw calls,
 * and a JavaScript loop that recomputes every sprite's spherical position on
 * every frame.
 *
 * Instanced, it is one geometry, one 1536x256 texture and one draw call, with
 * the drift computed in the vertex shader. Quads rather than points because
 * `gl_PointCoord` is square and the glyph cells are 8:1 — text in a point
 * sprite comes out squashed, and correcting for that means wasting seven
 * eighths of every sprite.
 */

const VERT = /* glsl */ `
attribute vec3 aOrbit;      // phi, radius, theta0
attribute float aSpeed;
attribute float aCell;
attribute float aSize;
attribute float aAlpha;
uniform float uTime;
uniform vec2 uAtlasGrid;    // columns, rows
uniform float uAspect;      // cell width / height
varying vec2 vUv;
varying float vAlpha;

void main() {
  float phi = aOrbit.x;
  float radius = aOrbit.y;
  float theta = aOrbit.z + uTime * aSpeed;

  vec3 centre = vec3(
    radius * sin(phi) * cos(theta),
    radius * cos(phi),
    radius * sin(phi) * sin(theta)
  );

  // Billboard: offset in VIEW space so the quad always squarely faces the
  // camera. Offsetting in world space would leave the text edge-on for half
  // the orbit, which looks like glyphs blinking out at random.
  vec4 mv = modelViewMatrix * vec4(centre, 1.0);
  mv.xy += position.xy * vec2(aSize, aSize / uAspect);
  gl_Position = projectionMatrix * mv;

  // Pick this instance's cell out of the atlas grid.
  float col = mod(aCell, uAtlasGrid.x);
  float row = floor(aCell / uAtlasGrid.x);
  vUv = (vec2(col, row) + uv) / uAtlasGrid;
  vAlpha = aAlpha;
}
`

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;
uniform vec3 uAccent;
uniform float uEnergy;
varying vec2 vUv;
varying float vAlpha;
void main() {
  // The atlas is white text on transparent, so its red channel IS coverage.
  // Colour comes entirely from the accent, which is what lets the whole field
  // shift with the brain's state without a single pixel being redrawn.
  float coverage = texture2D(uAtlas, vUv).r;
  if (coverage < 0.02) discard;
  gl_FragColor = vec4(uAccent * (0.55 + uEnergy * 0.7), 1.0) * coverage * vAlpha;
}
`

interface Props {
  budget: OrbBudget
  innerRadius: number
  outerRadius: number
  seed: number
}

export function GlyphField({ budget, innerRadius, outerRadius, seed }: Props) {
  // The atlas needs a DOM canvas, so it is built in a memo on the client only.
  // One atlas per mount, disposed with the component — a leaked GPU texture per
  // hot reload adds up fast during development.
  const atlas = useMemo(() => (budget.glyphs > 0 ? buildGlyphAtlas() : null), [budget.glyphs])

  const texture = useMemo(() => {
    if (!atlas) return null
    const tex = new THREE.CanvasTexture(atlas.canvas)
    // Linear, no mipmaps: the glyphs are drifting and mostly small, and
    // mipmapping a 1536x256 atlas of thin type blurs it to mush at the sizes
    // that actually render.
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }, [atlas])

  useEffect(() => () => texture?.dispose(), [texture])

  const built = useMemo(
    () =>
      atlas
        ? buildGlyphs({
            count: budget.glyphs,
            cells: atlas.cells,
            innerRadius,
            outerRadius,
            seed,
          })
        : null,
    [atlas, budget.glyphs, innerRadius, outerRadius, seed],
  )

  const geometry = useMemo(() => {
    if (!built || !atlas) return null
    const geo = new THREE.InstancedBufferGeometry()
    // A unit quad centred on the origin; the vertex shader scales it per
    // instance. Two triangles, shared by every glyph in the field.
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    )
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2))
    geo.setIndex([0, 1, 2, 0, 2, 3])
    geo.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(built.orbits, 3))
    geo.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(built.speeds, 1))
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(built.cells, 1))
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(built.sizes, 1))
    geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(built.alphas, 1))
    geo.instanceCount = built.speeds.length
    return geo
  }, [built, atlas])

  useEffect(() => () => geometry?.dispose(), [geometry])

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAtlas: { value: null as THREE.Texture | null },
      uAtlasGrid: { value: new THREE.Vector2(1, 1) },
      uAspect: { value: CELL_W / CELL_H },
      uAccent: { value: new THREE.Color(1, 1, 1) },
      uEnergy: { value: 0.25 },
    }),
    [],
  )

  useEffect(() => {
    if (!atlas || !texture) return
    uniforms.uAtlas.value = texture
    uniforms.uAtlasGrid.value.set(atlas.columns, atlas.rows)
  }, [atlas, texture, uniforms])

  useFrame(() => {
    uniforms.uTime.value = orbDrive.time
    uniforms.uEnergy.value = orbDrive.energy
    uniforms.uAccent.value.setRGB(orbDrive.accent[0]!, orbDrive.accent[1]!, orbDrive.accent[2]!)
  })

  if (!geometry || !texture) return null

  return (
    <mesh geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        vertexShader={VERT}
        fragmentShader={FRAG}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}
