'use client'

import { forwardRef } from 'react'
import * as THREE from 'three'

/**
 * The visible light source that god rays radiate from.
 *
 * The effect needs a real mesh in the scene to compute occlusion against —
 * that's what makes the shafts break around the panels rather than washing
 * uniformly over them. Two constraints from the effect's contract, both of
 * which produce silent visual bugs when violated:
 *
 *   - it must not write depth, or it occludes itself;
 *   - it must be flagged transparent.
 *
 * Positioned high and behind the ring so the shafts rake down through the
 * carousel toward the camera, which is where they read as volume rather than
 * as a lens flare.
 *
 * SIZE IS THE WHOLE PROBLEM WITH THIS OBJECT. It was a radius-1.6 sphere at 25
 * units, which subtends about 7 degrees — roughly a sixth of the frame height —
 * and the effect's job is not to make that ball beautiful, so it rendered as a
 * flat pale disc sitting in the upper left. It read as a bug, and the shafts it
 * was supposedly there to cast were barely visible at all: the worst of both,
 * paying for a large occluder and getting no volume from it.
 *
 * At radius 0.22 it subtends about half a degree — a dozen pixels. That is small enough to read as a
 * light rather than an object, bloom turns it into a glow rather than a disc,
 * and the god-ray pass — which samples radially outward from its screen
 * position and does not care how big the source is — gets its origin without
 * the frame getting a sphere. The lost brightness is made back in the effect's
 * weight and exposure, where it becomes shafts instead of a ball.
 */
export const LightSource = forwardRef<THREE.Mesh>(function LightSource(_, ref) {
  return (
    // Pushed further up and out so the shafts rake diagonally across the ring
    // rather than radiating from a point most of the way into frame.
    <mesh ref={ref} position={[-6.4, 8.6, -16]}>
      {/* Low segment count on purpose: at this angular size it is a few pixels
          across, and no amount of tessellation is visible. */}
      <sphereGeometry args={[0.22, 10, 10]} />
      <meshBasicMaterial
        color="#dfe9ff"
        transparent
        depthWrite={false}
        // Bypasses tone mapping so it keeps its brightness instead of being
        // rolled off with the rest of the scene.
        //
        // Do NOT reach past white here. An HDR colour looks like the obvious
        // way to make a small source bloom hard, and it does bloom — but ACES
        // pushes values above 1 toward warm as it rolls them off, so the source
        // came out a saturated gold speckle. Brighter than white in this scene
        // does not read as "more light", it reads as a different, wronger
        // object.
        toneMapped={false}
        fog={false}
      />
    </mesh>
  )
})
