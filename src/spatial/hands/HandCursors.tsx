'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { handFrame } from '@/core/hands/handFrame'
import { PipelineMeter } from '@/core/hands/pipelineMeter'
import { useGestureStore } from '@/core/store/useGestureStore'
import { damp } from '@/lib/math'
import { INSTANT, SNAP } from '@/core/config/motion'
import { handToWorld } from './projection'

/**
 * Hand cursors and their trails.
 *
 * The single most important piece of feedback in the whole interface: without a
 * visible cursor, tracking that is working and tracking that has silently
 * failed look identical, and the user is left waving at a screen wondering
 * which. The cursor also has to communicate *gesture state* — a pinch has to
 * look different from an open hand before the pinch does anything.
 *
 * Reads `handFrame` directly rather than subscribing to a store: this updates
 * every frame, which is exactly what the render loop is for.
 */

const TRAIL_LENGTH = 22

interface CursorProps {
  handedness: 'left' | 'right'
  color: string
  /**
   * Whether this cursor publishes the pipeline metrics.
   *
   * Exactly one does. Both cursors run the same loop, so leaving it on for
   * both would have them writing alternate samples into a single exponential
   * average — and when only one hand is up, the other contributes a stream of
   * zeroes that halves every reading. A number that changes meaning depending
   * on how many hands you are holding up is worse than no number.
   */
  measure: boolean
}

function Cursor({ handedness, color, measure }: CursorProps) {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const group = useRef<THREE.Group>(null)
  const core = useRef<THREE.Mesh>(null)
  const ring = useRef<THREE.Mesh>(null)
  const coreMat = useRef<THREE.MeshBasicMaterial>(null)
  const ringMat = useRef<THREE.MeshBasicMaterial>(null)

  const target = useMemo(() => new THREE.Vector3(), [])
  const trailPositions = useMemo(() => new Float32Array(TRAIL_LENGTH * 3), [])

  // The instrument, and the scratch vector it is fed from. The arithmetic
  // lives in `pipelineMeter` rather than here because it needs to be tested at
  // a frame rate this environment cannot produce — see that file.
  const meter = useMemo(() => new PipelineMeter(), [])
  const projected = useMemo(() => new THREE.Vector3(), [])

  // Built imperatively rather than as `<line>` JSX: React's intrinsic-element
  // namespace resolves `line` to the SVG element, not three's, so the JSX form
  // fails to typecheck. A primitive sidesteps the collision entirely.
  const trailLine = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3))
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.35,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const line = new THREE.Line(geo, mat)
    line.frustumCulled = false
    return line
  }, [trailPositions, color])

  useEffect(() => {
    const line = trailLine
    return () => {
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    }
  }, [trailLine])

  useFrame((state, delta) => {
    const hand = handFrame[handedness]
    const g = group.current
    if (!g) return
    const dt = Math.min(delta, 0.1)

    // Fade the whole cursor out rather than hiding it: a cursor that blinks out
    // of existence on a dropped frame reads as a glitch.
    const targetScale = hand.visible ? 1 : 0
    g.scale.setScalar(damp(g.scale.x, targetScale, SNAP, dt))
    if (g.scale.x < 0.01) {
      g.visible = false
      return
    }
    g.visible = true

    if (hand.visible) {
      handToWorld(target, camera, hand.position.x, hand.position.y, hand.position.z)

      // Measured before the damp, not after: the question is how far the drawn
      // cursor is from where the hand actually is, and after the damp
      // `g.position` has already moved toward it.
      if (measure) {
        const m = handFrame.metrics
        meter.transport(m, hand.timestamp, m.capturedAt, performance.now())
        projected.copy(target).project(camera)
        meter.motion(m, {
          targetX: target.x,
          targetY: target.y,
          targetZ: target.z,
          drawnX: g.position.x,
          drawnY: g.position.y,
          drawnZ: g.position.z,
          screenX: (projected.x * size.width) / 2,
          screenY: (projected.y * size.height) / 2,
          dt,
        })
      }

      // Light smoothing on top of the One Euro filter: the filter tames sensor
      // jitter, this absorbs the discrete jumps between inference frames, which
      // arrive slower than the render loop.
      g.position.x = damp(g.position.x, target.x, INSTANT, dt)
      g.position.y = damp(g.position.y, target.y, INSTANT, dt)
      g.position.z = damp(g.position.z, target.z, INSTANT, dt)
    } else if (measure) {
      // A hand that left the frame and came back has no relationship to where
      // it was; carrying the old position across would report the gap between
      // them as a single enormous movement.
      meter.reset()
    }

    // Pinch closes the ring and brightens the core — visible *before* the
    // threshold trips, so the gesture is discoverable rather than binary.
    const pinch = hand.pinch
    if (ring.current) {
      const s = 1 - pinch * 0.55
      ring.current.scale.setScalar(damp(ring.current.scale.x, s, INSTANT, dt))
      ring.current.rotation.z += dt * (0.4 + pinch * 3)
    }
    if (coreMat.current) {
      coreMat.current.opacity = damp(coreMat.current.opacity, 0.5 + pinch * 0.5, SNAP, dt)
    }
    if (ringMat.current) {
      const active = hand.gesture !== 'idle'
      ringMat.current.opacity = damp(ringMat.current.opacity, active ? 0.9 : 0.35, SNAP, dt)
    }
    if (core.current) {
      const s = 1 + pinch * 0.6 + (hand.gesture === 'grab' ? 0.4 : 0)
      core.current.scale.setScalar(damp(core.current.scale.x, s, SNAP, dt))
    }

    // ── Trail ────────────────────────────────────────────────────────────────
    // Shift the buffer down one vertex and write the head. Cheap, and it gives
    // fast movement a motion streak that makes tracking latency read as
    // deliberate rather than laggy.
    if (hand.visible) {
      trailPositions.copyWithin(0, 3)
      trailPositions[(TRAIL_LENGTH - 1) * 3] = g.position.x
      trailPositions[(TRAIL_LENGTH - 1) * 3 + 1] = g.position.y
      trailPositions[(TRAIL_LENGTH - 1) * 3 + 2] = g.position.z
      trailLine.geometry.attributes.position!.needsUpdate = true
    }
    void state
  })

  return (
    <>
      <group ref={group}>
        <mesh ref={core}>
          <sphereGeometry args={[0.055, 16, 16]} />
          <meshBasicMaterial
            ref={coreMat}
            color={color}
            transparent
            opacity={0.6}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>

        {/* Billboarded so the ring always presents face-on to the viewer. */}
        <mesh ref={ring} quaternion={camera.quaternion}>
          <ringGeometry args={[0.13, 0.145, 48]} />
          <meshBasicMaterial
            ref={ringMat}
            color={color}
            transparent
            opacity={0.35}
            side={THREE.DoubleSide}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
      </group>

      {/* Trail lives outside the cursor group: its vertices are already in
          world space, so inheriting the group's transform would apply the
          position twice. */}
      <primitive object={trailLine} />
    </>
  )
}

export function HandCursors() {
  const inputMode = useGestureStore((s) => s.inputMode)
  if (inputMode !== 'hand') return null

  return (
    <>
      <Cursor handedness="left" color="#7c9cff" measure={false} />
      {/* The right hand carries the measurement: it is the one `getPrimaryHand`
          prefers, so it is the one actually driving the interface being
          judged. */}
      <Cursor handedness="right" color="#d6e4ff" measure />
    </>
  )
}
