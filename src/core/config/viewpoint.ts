/**
 * Where the viewer is, and how much of the world they can see.
 *
 * Extracted because two things now need it and they must not disagree. The
 * camera rig damps toward this position; the surface wall places screens at
 * angles measured FROM it. If the wall were laid out against a guessed
 * viewpoint, surfaces would sit outside the frustum — present, correct, and
 * invisible, which is the worst kind of wrong because nothing reports it.
 *
 * Plain numbers rather than a `THREE.Vector3` so the layout arithmetic can be
 * tested without a renderer.
 */

/** Resting camera position. The rig damps here whenever nothing is focused. */
export const CAMERA_BASE = { x: 0, y: 0.6, z: 11.5 } as const

/** Pulled in slightly when a panel is expanded. */
export const CAMERA_FOCUSED = { x: 0, y: 0.5, z: 10.3 } as const

/** Vertical field of view, degrees — matches the Canvas camera in Stage. */
export const FOV = 42

/**
 * The narrowest viewport the layout must still fit in.
 *
 * The horizontal field of view is the vertical one widened by the aspect
 * ratio, so a tall window sees LESS to the sides. Laying the wall out against a
 * 16:9 desktop and then opening it at 4:3 would push the outer surfaces off
 * screen. 1.4 is the suite's own 900x640 viewport, which is narrower than any
 * laptop this runs on and therefore a safe floor.
 */
export const MIN_ASPECT = 1.4

/** Half the horizontal field of view, radians, at a given aspect ratio. */
export const halfFovX = (aspect: number = MIN_ASPECT): number =>
  Math.atan(Math.tan(((FOV / 2) * Math.PI) / 180) * aspect)

/** Half the vertical field of view, radians. */
export const halfFovY = (): number => ((FOV / 2) * Math.PI) / 180
