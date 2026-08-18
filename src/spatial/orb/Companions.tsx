'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useMindStore, type CompanionRuntime } from '@/core/store/useMindStore'
import { damp } from '@/lib/math'
import { MAX_STEP, SETTLE } from '@/core/config/motion'
import { firePulse, orbDrive } from './orbDrive'
import { labelSprite } from './labelSprite'

/**
 * The Gana, orbiting.
 *
 * The mind's roster — Ganesha, Lakshmi, Brihaspati and the rest, each a markdown file with
 * its own brief, model and colour — becomes a small orb circling the main one.
 * When the mind dispatches one, a beam runs out to it and it brightens; when the
 * companion reports back, the beam retracts. The point is that delegation stops
 * being something buried in a log and becomes something you watch happen.
 *
 * Ported from the mind's own `hud/world/orbs.js` and `beams.js`, which had the
 * behaviour right. What changed is that a companion is four objects here rather
 * than six, the beam is a line rather than a mesh, and the whole roster costs
 * about five draw calls per companion instead of a scene graph per companion —
 * these sit alongside the avatar orb, and its budget is already spent.
 */

/** Golden angle, for spreading orbits that the mind did not give an explicit phase. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5))

/**
 * Orbits sit between the avatar's proton cloud and the carousel ring.
 *
 * Inside 3.8 they would be lost among the protons; outside 4.6 they would
 * intersect the instrument panels.
 */
const MIN_R = 4.0
const MAX_R = 4.45

/** How bright a companion glows in each state, and how fast it turns. */
const STATE_DRIVE: Record<CompanionRuntime['state'], { glow: number; speed: number }> = {
  dormant: { glow: 0.28, speed: 1 },
  working: { glow: 1.0, speed: 2.6 },
  returning: { glow: 0.75, speed: 1.8 },
  done: { glow: 0.5, speed: 1.1 },
  failed: { glow: 0.45, speed: 0.7 },
}

interface OrbitParams {
  radius: number
  incline: number
  phase: number
  speed: number
}

function orbitFor(companion: CompanionRuntime, index: number): OrbitParams {
  const o = companion.orbit
  return {
    // the mind's companion files may specify an orbit; when they do not, a golden
    // angle spread is what stops two companions sitting on top of each other.
    radius: clampRadius(o.radius ?? MIN_R + (index % 3) * 0.22),
    incline: ((o.incline ?? index * 17 - 25) * Math.PI) / 180,
    phase: o.phase !== undefined ? (o.phase * Math.PI) / 180 : index * GOLDEN,
    speed: 0.11 + (index % 4) * 0.024,
  }
}

const clampRadius = (r: number): number => Math.min(MAX_R, Math.max(MIN_R, r))

export function Companions() {
  const companions = useMindStore((s) => s.companions)
  if (companions.length === 0) return null
  return (
    <group>
      {companions.map((companion, i) => (
        <Companion key={companion.slug} companion={companion} index={i} />
      ))}
    </group>
  )
}

function Companion({ companion, index }: { companion: CompanionRuntime; index: number }) {
  const group = useRef<THREE.Group>(null)
  const body = useRef<THREE.Mesh>(null)
  const cage = useRef<THREE.Mesh>(null)

  const orbit = useMemo(() => orbitFor(companion, index), [companion, index])
  const color = useMemo(() => new THREE.Color(companion.color), [companion.color])

  // Both label sprites are built once per companion and disposed with it. A
  // roster refresh re-runs this only if the name or colour actually changed.
  const nameLabel = useMemo(
    () => labelSprite(companion.name, companion.color, 0.17),
    [companion.name, companion.color],
  )
  const roleLabel = useMemo(
    () => labelSprite(companion.role.toUpperCase(), '#8fa3c8', 0.11),
    [companion.role],
  )
  useEffect(() => () => nameLabel.dispose(), [nameLabel])
  useEffect(() => () => roleLabel.dispose(), [roleLabel])

  // Two points: the centre of the avatar and the companion. Rewritten in place
  // each frame while a beam is live, so no geometry is allocated per frame.
  const beamGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3))
    return geo
  }, [])
  useEffect(() => () => beamGeometry.dispose(), [beamGeometry])

  const beamLine = useMemo(() => {
    // Built imperatively: React's intrinsic element namespace resolves `line`
    // to the SVG element rather than three's, so the JSX form does not
    // typecheck. `HandCursors` sidesteps the same collision the same way.
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const line = new THREE.Line(beamGeometry, material)
    line.frustumCulled = false
    return line
  }, [beamGeometry, color])
  useEffect(() => {
    const line = beamLine
    return () => (line.material as THREE.Material).dispose()
  }, [beamLine])

  // Fires a pulse through the avatar's network when this companion is sent
  // out, so the dispatch reads as coming FROM SHIVA rather than happening
  // beside it.
  const lastState = useRef(companion.state)
  useEffect(() => {
    if (companion.state === 'working' && lastState.current !== 'working') {
      firePulse(0, 0, 0)
    }
    lastState.current = companion.state
  }, [companion.state])

  useFrame((_, dt) => {
    const g = group.current
    if (!g) return
    const step = Math.min(dt, MAX_STEP)
    const drive = STATE_DRIVE[companion.state]
    const t = orbDrive.time

    const angle = t * orbit.speed * drive.speed + orbit.phase
    g.position.set(
      Math.cos(angle) * orbit.radius,
      Math.sin(orbit.incline) * orbit.radius * 0.35 + Math.sin(angle * 0.6) * 0.18,
      Math.sin(angle) * orbit.radius * Math.cos(orbit.incline),
    )

    if (body.current) {
      const material = body.current.material as THREE.MeshBasicMaterial
      // A slow breath on top of the state's level, so a dormant companion is
      // still visibly alive rather than a dead marker.
      const breathe = 0.85 + 0.15 * Math.sin(t * 1.4 + orbit.phase)
      material.opacity = damp(material.opacity, drive.glow * breathe, SETTLE, step)
      body.current.scale.setScalar(
        damp(body.current.scale.x, 0.85 + drive.glow * 0.5, SETTLE, step),
      )
    }
    if (cage.current) {
      cage.current.rotation.y += step * (0.4 + drive.glow)
      cage.current.rotation.x += step * 0.2
      const material = cage.current.material as THREE.MeshBasicMaterial
      material.opacity = damp(material.opacity, 0.12 + drive.glow * 0.4, SETTLE, step)
    }

    // The beam only exists while the companion is actually out.
    const live = companion.state === 'working' || companion.state === 'returning'
    const material = beamLine.material as THREE.LineBasicMaterial
    material.opacity = damp(material.opacity, live ? 0.5 : 0, SETTLE, step)
    if (material.opacity > 0.01) {
      const positions = beamGeometry.attributes.position as THREE.BufferAttribute
      positions.setXYZ(0, 0, 0, 0)
      positions.setXYZ(1, g.position.x, g.position.y, g.position.z)
      positions.needsUpdate = true
    }
  })

  return (
    <>
      <primitive object={beamLine} />
      <group ref={group}>
        <mesh ref={body}>
          <icosahedronGeometry args={[0.14, 2]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.3}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
        <mesh ref={cage}>
          <icosahedronGeometry args={[0.21, 1]} />
          <meshBasicMaterial
            color={color}
            wireframe
            transparent
            opacity={0.2}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
        <primitive object={nameLabel.sprite} position={[0, 0.36, 0]} />
        <primitive object={roleLabel.sprite} position={[0, 0.23, 0]} />
      </group>
    </>
  )
}
