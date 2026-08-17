'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { MeshTransmissionMaterial } from '@react-three/drei'
import { RigidBody, type RapierRigidBody } from '@react-three/rapier'
import * as THREE from 'three'
import type { ModuleDescriptor } from '@/core/types'
import type { QualitySettings } from '@/core/config/quality'
import { damp } from '@/lib/math'
import { emit } from '@/core/events/bus'
import { resolveColor } from '@/core/config/palette'
import { createPanelTexture } from './panelTexture'

/**
 * A single glass panel.
 *
 * Panels have three modes and the transitions between them are the whole
 * interaction model:
 *
 *   ring     — held on its carousel slot, position driven kinematically
 *   held     — following a hand, still kinematic
 *   thrown   — released as a dynamic body with the hand's velocity, then
 *              reeled back to its slot by a spring
 *
 * Rapier owns the body in all three; only the body *type* changes. Simulating
 * the ring itself would be both more expensive and far less art-directable —
 * a carousel that can be knocked out of alignment by a stray nudge is a toy,
 * not an interface.
 */

const PANEL_W = 2.5
const PANEL_H = 3.4
const PANEL_D = 0.14

/** Below these thresholds a thrown panel is considered home and re-docks. */
const SETTLE_DISTANCE = 0.35
const SETTLE_SPEED = 1.2

export interface PanelTransform {
  position: THREE.Vector3
  rotationY: number
  /** 0 at the back of the ring, 1 when facing the camera. */
  prominence: number
}

/** Imperative handle the ring uses to launch a panel on release. */
export interface PanelApi {
  /** Convert to a dynamic body and impart the throw. */
  launch: (velocity: THREE.Vector3) => void
}

interface Props {
  module: ModuleDescriptor
  index: number
  quality: QualitySettings
  focused: boolean
  held: boolean
  /** Where this panel's slot currently is, recomputed each frame by the ring. */
  slot: React.RefObject<PanelTransform>
  /** Live hand/pointer target while held. */
  holdTarget: React.RefObject<THREE.Vector3>
  /** Registers this panel's imperative handle with the ring. */
  register: (index: number, api: PanelApi | null) => void
}

function makePanelGeometry(): THREE.ExtrudeGeometry {
  const r = 0.16
  const w = PANEL_W / 2
  const h = PANEL_H / 2
  const shape = new THREE.Shape()
  shape.moveTo(-w + r, -h)
  shape.lineTo(w - r, -h)
  shape.quadraticCurveTo(w, -h, w, -h + r)
  shape.lineTo(w, h - r)
  shape.quadraticCurveTo(w, h, w - r, h)
  shape.lineTo(-w + r, h)
  shape.quadraticCurveTo(-w, h, -w, h - r)
  shape.lineTo(-w, -h + r)
  shape.quadraticCurveTo(-w, -h, -w + r, -h)

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: PANEL_D,
    bevelEnabled: true,
    // A crisp bevel is what catches the key light and gives the edge its rim —
    // a flat extrusion reads as cardboard under any lighting.
    bevelThickness: 0.02,
    bevelSize: 0.018,
    bevelSegments: 3,
    curveSegments: 8,
  })
  geo.center()
  return geo
}

export function GlassPanel({
  module,
  index,
  quality,
  focused,
  held,
  slot,
  holdTarget,
  register,
}: Props) {
  const body = useRef<RapierRigidBody>(null)
  const group = useRef<THREE.Group>(null)
  const content = useRef<THREE.MeshBasicMaterial>(null)
  const edge = useRef<THREE.MeshBasicMaterial>(null)

  const geometry = useMemo(() => makePanelGeometry(), [])
  const texture = useMemo(() => createPanelTexture(module, index), [module, index])
  const accentColor = useMemo(() => new THREE.Color(resolveColor(module.accent)), [module.accent])

  // Neither the geometry nor the canvas texture is created by R3F's reconciler,
  // so neither is disposed automatically.
  useEffect(() => () => void (geometry.dispose(), texture.dispose()), [geometry, texture])

  const tmp = useMemo(() => new THREE.Vector3(), [])
  const tmpQuat = useMemo(() => new THREE.Quaternion(), [])
  const euler = useMemo(() => new THREE.Euler(), [])

  // Publish the launch handle so the ring can throw this panel on release.
  useEffect(() => {
    register(index, {
      launch: (velocity) => {
        const rb = body.current
        if (!rb) return
        rb.setBodyType(0, true) // dynamic
        rb.setLinvel({ x: velocity.x, y: velocity.y, z: velocity.z }, true)
        // Spin proportional to the throw, capped so a hard fling doesn't turn
        // the panel into an unreadable blur.
        rb.setAngvel(
          {
            x: THREE.MathUtils.clamp(-velocity.y * 0.4, -3, 3),
            y: THREE.MathUtils.clamp(velocity.x * 0.4, -3, 3),
            z: 0,
          },
          true,
        )
      },
    })
    return () => register(index, null)
  }, [index, register])

  useFrame((state, delta) => {
    const rb = body.current
    const target = slot.current
    if (!rb || !target) return
    const dt = Math.min(delta, 0.1)

    const thrown = rb.bodyType() === 0 // rapier: 0 = dynamic

    if (thrown) {
      // Reel the panel home with a spring, so a throw is a flourish rather than
      // a way to permanently lose a panel off-screen.
      const pos = rb.translation()
      tmp.set(target.position.x - pos.x, target.position.y - pos.y, target.position.z - pos.z)
      const distance = tmp.length()
      const vel = rb.linvel()
      const speed = Math.hypot(vel.x, vel.y, vel.z)

      if (distance < SETTLE_DISTANCE && speed < SETTLE_SPEED) {
        rb.setBodyType(2, true) // kinematicPosition
        emit('ui:confirm', { intensity: 0.25 })
      } else {
        // Spring strengthens with distance so a hard throw returns promptly
        // without making a gentle one feel yanked.
        const k = 6 + distance * 2.5
        rb.applyImpulse({ x: tmp.x * k * dt, y: tmp.y * k * dt, z: tmp.z * k * dt }, true)
      }
    } else {
      // Kinematic: drive straight to the goal, easing so the ring glides.
      const goal = held && holdTarget.current ? holdTarget.current : target.position
      const pos = rb.translation()
      const lambda = held ? 18 : 5.2
      rb.setNextKinematicTranslation({
        x: damp(pos.x, goal.x, lambda, dt),
        y: damp(pos.y, goal.y, lambda, dt),
        z: damp(pos.z, goal.z, lambda, dt),
      })

      // Held panels face the viewer squarely; ringed ones keep their slot's yaw.
      euler.set(0, held ? 0 : target.rotationY, 0)
      if (held) {
        // A slight tilt sells the sense of a physical object being handled.
        euler.x = Math.sin(state.clock.elapsedTime * 2) * 0.04
        euler.z = Math.cos(state.clock.elapsedTime * 1.6) * 0.03
      }
      tmpQuat.setFromEuler(euler)
      rb.setNextKinematicRotation(tmpQuat)
    }

    // Prominence drives the panel's presence: the front panel is brighter and
    // its content more opaque, so attention has an obvious home.
    const prominence = held || focused ? 1 : target.prominence
    if (content.current) {
      content.current.opacity = damp(content.current.opacity, 0.25 + prominence * 0.75, 6, dt)
    }
    if (edge.current) {
      edge.current.opacity = damp(edge.current.opacity, 0.1 + prominence * 0.5, 6, dt)
    }
  })

  return (
    <RigidBody
      ref={body}
      type="kinematicPosition"
      colliders="cuboid"
      // The ring is the arbiter of layout; gravity would fight it every frame.
      gravityScale={0}
      linearDamping={1.4}
      angularDamping={2.2}
      restitution={0.35}
      friction={0.4}
      canSleep={false}
    >
      <group ref={group}>
        <mesh geometry={geometry} castShadow={quality.shadows} receiveShadow={quality.shadows}>
          <MeshTransmissionMaterial
            // Uses three's shared transmission pass instead of an FBO render per
            // mesh. With six panels the per-mesh path would mean six extra
            // scene renders every frame.
            transmissionSampler
            samples={quality.transmissionSamples}
            resolution={quality.transmissionResolution}
            transmission={1}
            thickness={0.55}
            roughness={0.14}
            ior={1.42}
            chromaticAberration={quality.chromaticAberration ? 0.06 : 0}
            anisotropicBlur={0.4}
            distortion={0.12}
            distortionScale={0.3}
            temporalDistortion={0.04}
            color="#cfd8ee"
            attenuationColor="#8fa4c8"
            attenuationDistance={2.4}
          />
        </mesh>

        {/* Content, floated just proud of the glass so it reads as projected
            onto the surface rather than embedded in it. */}
        <mesh position={[0, 0, PANEL_D / 2 + 0.012]}>
          <planeGeometry args={[PANEL_W * 0.92, PANEL_H * 0.92]} />
          <meshBasicMaterial
            ref={content}
            map={texture}
            transparent
            opacity={0.6}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>

        {/* Emissive edge — the element bloom latches onto. */}
        <mesh position={[0, 0, -PANEL_D / 2 - 0.004]}>
          <planeGeometry args={[PANEL_W * 1.015, PANEL_H * 1.012]} />
          <meshBasicMaterial
            ref={edge}
            color={accentColor}
            transparent
            opacity={0.2}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </mesh>
      </group>
    </RigidBody>
  )
}

export { PANEL_W, PANEL_H, PANEL_D }
