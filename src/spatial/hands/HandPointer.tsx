'use client'

import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { getPrimaryHand } from '@/core/hands/handFrame'
import { useGestureStore } from '@/core/store/useGestureStore'
import { driveDomPointer, resetPointerBridge } from './pointerBridge'
import { handToWorld } from './projection'

/**
 * Feeds the DOM pointer bridge from the tracked hand, once per frame.
 *
 * Lives inside the Canvas because it needs the camera: the cursor's position is
 * decided in world space by `handToWorld`, and the DOM has to be told where
 * that lands on screen. Projecting the same world point the visible cursor uses
 * — rather than mapping tracking space to the viewport independently — is what
 * guarantees the hand touches the thing it is drawn on top of. Two separate
 * mappings would drift apart at the edges of the frame, where the cursor's
 * overscan applies and a naive mapping's does not.
 */
export function HandPointer() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const inputMode = useGestureStore((s) => s.inputMode)

  const world = useMemo(() => new THREE.Vector3(), [])
  const ndc = useMemo(() => new THREE.Vector3(), [])

  useEffect(() => resetPointerBridge, [])

  // Releases anything held when the user picks the mouse back up, so a press
  // cannot survive the handover and leave an element stuck down.
  useEffect(() => {
    if (inputMode !== 'hand') resetPointerBridge()
  }, [inputMode])

  useFrame(() => {
    if (inputMode !== 'hand') return

    const hand = getPrimaryHand()
    if (!hand?.visible) {
      driveDomPointer(null, null, false)
      return
    }

    handToWorld(world, camera, hand.position.x, hand.position.y, hand.position.z)
    ndc.copy(world).project(camera)

    // Viewport coordinates, not canvas-relative ones: `elementFromPoint` is a
    // document API and takes client space.
    const rect = gl.domElement.getBoundingClientRect()
    const x = rect.left + ((ndc.x + 1) / 2) * rect.width
    const y = rect.top + ((1 - ndc.y) / 2) * rect.height

    // Behind the camera, `project` flips the sign and the point lands on the
    // opposite side of the screen — so a hand that has gone out of range would
    // silently start pressing things in the far corner.
    if (ndc.z > 1) {
      driveDomPointer(null, null, false)
      return
    }

    driveDomPointer(x, y, hand.gesture === 'pinch')
  })

  return null
}
