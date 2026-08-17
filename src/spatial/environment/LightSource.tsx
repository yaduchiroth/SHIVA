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
 */
export const LightSource = forwardRef<THREE.Mesh>(function LightSource(_, ref) {
  return (
    <mesh ref={ref} position={[-4.5, 7, -14]}>
      <sphereGeometry args={[1.6, 24, 24]} />
      <meshBasicMaterial
        color="#dfe9ff"
        transparent
        depthWrite={false}
        // Bypasses tone mapping so it stays above the bloom threshold and
        // actually reads as a light rather than a pale grey ball.
        toneMapped={false}
        fog={false}
      />
    </mesh>
  )
})
