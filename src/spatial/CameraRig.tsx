'use client'

import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { damp } from '@/lib/math'
import { useSpatialStore } from '@/core/store/useSpatialStore'
import { getPrimaryHand } from '@/core/hands/handFrame'
import { useGestureStore } from '@/core/store/useGestureStore'

/**
 * Camera choreography.
 *
 * The camera is never static and never under direct user control. It responds
 * to where attention is — leaning toward a hand, pulling back when a panel
 * expands, breathing slightly when idle. This is what separates a spatial OS
 * from an orbit-controls demo: you don't fly the camera, the camera reacts to
 * you.
 */

// Framing: the ring sits at radius 4.6, so the front panel is ~6.9 units away
// from here. At a 42° fov that puts a 3.4-unit panel at roughly two-thirds of
// frame height — enough presence to be the subject, with the neighbouring
// panels still legible either side. Closer than this and the front panel is
// cropped by the frame edges.
const BASE = new THREE.Vector3(0, 0.6, 11.5)
// Focused: close enough that the panel fills ~85% of frame height, which is
// what makes committing to a panel feel like stepping up to it.
const FOCUSED = new THREE.Vector3(0, 0.5, 10.3)

export function CameraRig({ reducedMotion }: { reducedMotion: boolean }) {
  const camera = useThree((s) => s.camera)
  const pointer = useThree((s) => s.pointer)
  const focused = useSpatialStore((s) => s.focused)
  const idle = useSpatialStore((s) => s.idle)
  const dolly = useSpatialStore((s) => s.dolly)
  const inputMode = useGestureStore((s) => s.inputMode)

  const target = useRef(new THREE.Vector3().copy(BASE))
  const lookAt = useRef(new THREE.Vector3(0, 0, 0))

  useFrame((state, delta) => {
    // Long tab-backgrounding produces a huge delta that would teleport the
    // camera on the first frame back.
    const dt = Math.min(delta, 0.1)
    const t = state.clock.elapsedTime

    const base = focused !== null ? FOCUSED : BASE
    target.current.copy(base)
    // The two-handed spread scales distance rather than replacing it, so the
    // rig's own framing decisions still apply underneath — pull in on focus,
    // drift when idle — and the user is adjusting them rather than overriding.
    target.current.z *= dolly

    if (!reducedMotion) {
      // Idle breathing — a slow vertical drift that keeps the frame alive.
      if (idle) {
        target.current.y += Math.sin(t * 0.24) * 0.22
        target.current.x += Math.cos(t * 0.17) * 0.3
      }

      // Parallax lean. With hands, follow the hand; with a mouse, follow the
      // pointer. Same effect, whichever input is live.
      const hand = inputMode === 'hand' ? getPrimaryHand() : null
      const leanX = hand?.visible ? (hand.position.x - 0.5) * -2 : pointer.x
      const leanY = hand?.visible ? (hand.position.y - 0.5) * 2 : pointer.y

      target.current.x += leanX * 0.55
      target.current.y += leanY * 0.35
    }

    // Frame-rate independent easing. Focus transitions are snappier than idle
    // drift so committing to a panel feels decisive.
    const lambda = focused !== null ? 3.4 : 1.6
    camera.position.x = damp(camera.position.x, target.current.x, lambda, dt)
    camera.position.y = damp(camera.position.y, target.current.y, lambda, dt)
    camera.position.z = damp(camera.position.z, target.current.z, lambda, dt)

    // Aim slightly above origin so the carousel sits in the lower two-thirds —
    // headroom reads as composed, dead-centre reads as a screensaver.
    // A focused panel rides higher on the ring, so the aim has to rise with it.
    lookAt.current.set(0, focused !== null ? 0.45 : 0.35, 0)
    camera.lookAt(lookAt.current)
  })

  return null
}
