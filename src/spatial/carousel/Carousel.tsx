'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Physics } from '@react-three/rapier'
import * as THREE from 'three'
import { MODULES } from '@/core/config/modules'
import type { QualitySettings } from '@/core/config/quality'
import { useSpatialStore } from '@/core/store/useSpatialStore'
import { useGestureStore } from '@/core/store/useGestureStore'
import { getPrimaryHand } from '@/core/hands/handFrame'
import { emit, on } from '@/core/events/bus'
import { dampAngle, clamp } from '@/lib/math'
import { handToWorld } from '../hands/projection'
import { GlassPanel, type PanelApi, type PanelTransform } from './GlassPanel'

const RADIUS = 4.6
const STEP = (Math.PI * 2) / MODULES.length

/**
 * The orbit.
 *
 * Slot transforms are recomputed every frame into refs that the panels read.
 * They deliberately never enter React state: the ring rotates continuously, and
 * a store write per frame would re-render six panels sixty times a second to
 * communicate numbers that only the render loop consumes.
 */
export function Carousel({
  quality,
  reducedMotion,
}: {
  quality: QualitySettings
  reducedMotion: boolean
}) {
  const camera = useThree((s) => s.camera)
  const index = useSpatialStore((s) => s.index)
  const focused = useSpatialStore((s) => s.focused)
  const grabbed = useSpatialStore((s) => s.grabbed)
  const setGrabbed = useSpatialStore((s) => s.setGrabbed)
  const step = useSpatialStore((s) => s.step)
  const inputMode = useGestureStore((s) => s.inputMode)

  // Smoothed rotation trails the discrete target index.
  const rotation = useRef(0)

  // Imperative handles, keyed by panel index. A registry rather than state:
  // registration happens during mount effects and is consumed only by event
  // handlers, so nothing here should trigger a re-render.
  const panelApis = useRef(new Map<number, PanelApi>())
  const register = useCallback((panelIndex: number, api: PanelApi | null) => {
    if (api) panelApis.current.set(panelIndex, api)
    else panelApis.current.delete(panelIndex)
  }, [])

  const slots = useMemo(
    () =>
      MODULES.map(
        () =>
          ({
            position: new THREE.Vector3(),
            rotationY: 0,
            prominence: 0,
          }) satisfies PanelTransform,
      ),
    [],
  )
  const slotRefs = useMemo(
    () => slots.map((slot) => ({ current: slot }) as React.RefObject<PanelTransform>),
    [slots],
  )

  const holdTarget = useRef(new THREE.Vector3())
  const holdTargetRef = holdTarget as React.RefObject<THREE.Vector3>
  const throwVec = useMemo(() => new THREE.Vector3(), [])

  // ── Interaction wiring ─────────────────────────────────────────────────────
  useEffect(() => {
    const offStep = on('carousel:step', ({ direction }) => step(direction))

    const offGrab = on('panel:grab', ({ index: panelIndex }) => {
      setGrabbed(panelIndex)
      emit('ui:confirm', { intensity: 0.6 })
    })

    const offRelease = on('panel:release', ({ index: panelIndex, velocity }) => {
      setGrabbed(null)
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z)
      // Below this the release was a place, not a throw — let it glide back to
      // its slot kinematically instead of nudging it into a physics sim.
      if (speed > 0.8) {
        panelApis.current.get(panelIndex)?.launch(throwVec.set(velocity.x, velocity.y, velocity.z))
      }
      emit('ui:confirm', { intensity: 0.35 })
    })

    return () => {
      offStep()
      offGrab()
      offRelease()
    }
  }, [step, setGrabbed, throwVec])

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1)

    // Ease the ring toward the target slot. Taking the short way around matters:
    // stepping from panel 5 to panel 0 should advance one slot, not unwind five.
    const targetRotation = -index * STEP
    rotation.current = dampAngle(rotation.current, targetRotation, 4.2, dt)

    const t = state.clock.elapsedTime

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!
      const angle = rotation.current + i * STEP

      // z = cos so angle 0 puts the panel nearest the camera.
      const sin = Math.sin(angle)
      const cos = Math.cos(angle)

      // Prominence: 1 facing the viewer, 0 at the back of the ring.
      const prominence = clamp((cos + 1) / 2, 0, 1)
      const eased = prominence * prominence

      const isFocused = focused === i
      // A focused panel steps OUT of the ring, toward the viewer. The camera
      // sits at +z, so that means a larger radius — pulling it inward would move
      // it further away and make it smaller, which is the opposite of focus.
      const radius = isFocused ? RADIUS * 1.08 : RADIUS

      slot.position.set(sin * radius, 0, cos * radius)

      // Panels lift as they come forward, so the ring reads as a shallow bowl
      // rather than a flat lazy susan.
      slot.position.y = -0.35 + eased * 0.5
      if (!reducedMotion) {
        // Each panel bobs on its own phase — synchronised motion looks mechanical.
        slot.position.y += Math.sin(t * 0.6 + i * 1.7) * 0.06 * (1 - eased * 0.6)
      }
      if (isFocused) slot.position.y += 0.25

      // Face outward from the ring centre, which points the front panel at the
      // camera. Rear panels turn away, and that's intended — the back of the
      // ring should read as depth, not as competing content.
      slot.rotationY = angle
      slot.prominence = prominence
    }

    // ── Hold target ──────────────────────────────────────────────────────────
    if (grabbed !== null) {
      if (inputMode === 'hand') {
        const hand = getPrimaryHand()
        if (hand?.visible) {
          handToWorld(holdTarget.current, camera, hand.position.x, hand.position.y, hand.position.z)
        }
      } else {
        // Pointer drives the identical path: unproject the mouse onto the same
        // interaction plane the hand would land on.
        handToWorld(
          holdTarget.current,
          camera,
          (1 - state.pointer.x) / 2,
          (1 - state.pointer.y) / 2,
          0,
        )
      }
    }
  })

  return (
    <Physics
      // Gravity is zero because the ring, not the world, decides where panels
      // live. Rapier is here for collisions and throw dynamics only.
      gravity={[0, 0, 0]}
      timeStep="vary"
      paused={false}
    >
      {MODULES.map((module, i) => (
        <GlassPanel
          key={module.id}
          module={module}
          index={i}
          quality={quality}
          focused={focused === i}
          held={grabbed === i}
          slot={slotRefs[i]!}
          holdTarget={holdTargetRef}
          register={register}
        />
      ))}
    </Physics>
  )
}
