import * as THREE from 'three'
import { clamp } from '@/lib/math'

/**
 * Normalised tracking space → world space.
 *
 * MediaPipe reports landmarks in video-frame coordinates: x/y in 0..1 with the
 * origin at top-left, and z as a rough depth offset relative to the wrist.
 * Three coordinate conventions have to be reconciled:
 *
 *   1. Y is inverted (video counts down, world counts up).
 *   2. X is mirrored. The webcam feed is shown mirrored — as users expect,
 *      since an un-mirrored self-view feels broken — so a hand moving to the
 *      user's right must move right on screen, which is -x in tracking space.
 *   3. Landmarks are 2D-ish. Rather than trusting MediaPipe's noisy z for
 *      absolute depth, we project onto a plane at a fixed distance in front of
 *      the camera and use z only as a small parallax offset.
 */

const NDC_RANGE = 1.6 // Slight overscan so tracking reaches past the frame edge.

export function handToWorld(
  out: THREE.Vector3,
  camera: THREE.Camera,
  x: number,
  y: number,
  z: number,
  distance = 6.5,
): THREE.Vector3 {
  // Mirror x, flip y, and expand to NDC.
  const ndcX = clamp((0.5 - x) * 2 * NDC_RANGE, -1.6, 1.6)
  const ndcY = clamp((0.5 - y) * 2 * NDC_RANGE, -1.6, 1.6)

  out.set(ndcX, ndcY, 0.5).unproject(camera)

  // Walk along the camera ray to the interaction plane. MediaPipe's z is
  // relative and unreliable in absolute terms, so it only nudges depth —
  // enough to convey reaching in and out, not enough to cause jitter in Z.
  const depth = distance + clamp(z, -0.35, 0.35) * 4

  out.sub(camera.position).normalize().multiplyScalar(depth).add(camera.position)
  return out
}
