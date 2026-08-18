import { CAMERA_BASE, halfFovX, halfFovY } from '@/core/config/viewpoint'

/**
 * Where surfaces sit in the room.
 *
 * Laid out in angles measured FROM THE VIEWER rather than as positions around
 * the origin, and that choice is the whole design. An arc struck around the
 * world's centre looks reasonable on paper and puts screens outside the
 * frustum in practice: the camera sits 11.5 units back, so a surface only 30
 * degrees around a radius-7 arc is already 34 degrees off the view axis, well
 * past the 28 degrees a 4:3 window can see. The first version of this did
 * exactly that, and the surfaces were present, correctly positioned, and
 * invisible — which nothing reports, because nothing is wrong.
 *
 * Placing them at a yaw and pitch from the eye means the fit can be *proved*
 * instead of eyeballed, and the test below does prove it. Everything is pure
 * arithmetic so the arrangement is checkable without a renderer, and so the two
 * things that must agree — the WebGL frame and the DOM inside it — are computed
 * once rather than twice.
 */

/**
 * A surface's content size in CSS pixels, and the world size it maps to.
 *
 * drei's `Html` in `transform` mode, with no `distanceFactor`, maps one world
 * unit to 40 CSS pixels. So the scale is derived from the world size we want
 * rather than typed in: a hand-tuned scale here silently disagrees with the
 * frame drawn in WebGL, and a border that no longer lines up with its content
 * is the tell that gives away that these are two rendering systems pretending
 * to be one object.
 */
export const SURFACE_PX = { width: 460, height: 320 } as const
const DREI_PX_PER_UNIT = 40

/** World width of a surface. Everything else is derived from it. */
export const SURFACE_W = 1.75
export const SURFACE_H = SURFACE_W * (SURFACE_PX.height / SURFACE_PX.width)
export const SURFACE_SCALE = SURFACE_W / (SURFACE_PX.width / DREI_PX_PER_UNIT)

export interface SurfaceTransform {
  position: [number, number, number]
  /** Euler XYZ, radians. Turned to face the viewer square-on. */
  rotation: [number, number, number]
}

export interface WallSpec {
  /** Distance from the eye. Sets how large a surface reads, and how far to reach. */
  distance: number
  /** Yaw between adjacent columns, radians. */
  yawStep: number
  /** Pitch between rows, radians. */
  pitchStep: number
  /** Columns before a new row starts. */
  perRow: number
}

/**
 * Six metres of nothing between you and the screens would be a waste of a
 * room, and six centimetres would be a headache. At 6.0 units a surface
 * subtends about 17 degrees — roughly a laptop display at arm's length — and
 * the front of the wall lands at z = 5.5, just outside the carousel ring at
 * 4.6, so content sits in front of the instruments rather than tangled in them.
 *
 * The steps are the surface's own angular size plus a margin, so neighbours
 * never overlap and never drift apart as the distance changes.
 */
export const WALL: WallSpec = {
  distance: 6.0,
  yawStep: 0.315,
  pitchStep: 0.29,
  perRow: 3,
}

/** Angular half-size of a surface at the wall distance. Used to prove the fit. */
export const surfaceHalfAngle = (wall: WallSpec = WALL) => ({
  yaw: Math.atan(SURFACE_W / 2 / wall.distance),
  pitch: Math.atan(SURFACE_H / 2 / wall.distance),
})

/** How many rows `count` surfaces occupy. */
export const rowsFor = (count: number, wall: WallSpec = WALL): number =>
  Math.max(1, Math.ceil(count / wall.perRow))

/**
 * Places surface `i` of `count`.
 *
 * A lone surface goes dead ahead. The obvious indexing — `i / (count - 1)` —
 * divides by zero there and puts it at one end, which is the one case every
 * user sees first.
 */
export function slotTransform(i: number, count: number, wall: WallSpec = WALL): SurfaceTransform {
  const row = Math.floor(i / wall.perRow)
  const rows = rowsFor(count, wall)
  const inRow = i % wall.perRow
  // The final row is usually short. Spacing it as though it were full would
  // leave it hanging off to one side instead of centred under the rest.
  const rowCount = Math.min(wall.perRow, count - row * wall.perRow)

  const yaw = (inRow - (rowCount - 1) / 2) * wall.yawStep
  // Rows are centred on the eye line, so a second row pushes the first DOWN
  // rather than shifting the whole array up out of frame.
  const pitch = -(row - (rows - 1) / 2) * wall.pitchStep

  const cosPitch = Math.cos(pitch)
  const position: [number, number, number] = [
    CAMERA_BASE.x + wall.distance * Math.sin(yaw) * cosPitch,
    CAMERA_BASE.y + wall.distance * Math.sin(pitch),
    // The camera looks down -z, so the wall is in front of it at lower z.
    CAMERA_BASE.z - wall.distance * Math.cos(yaw) * cosPitch,
  ]

  // Turned back toward the eye, so every surface is seen square-on wherever it
  // sits. Without the pitch term the upper row shows its underside.
  return { position, rotation: [-pitch, yaw, 0] }
}

/**
 * Whether every slot of a full wall lands inside the frustum, with its whole
 * width and height.
 *
 * Exported so the test asserts the real condition rather than a proxy for it —
 * and so that changing `WALL` and forgetting to check is a test failure rather
 * than a set of screens nobody can see.
 */
export function wallFitsFrustum(count: number, aspect: number, wall: WallSpec = WALL): boolean {
  const half = surfaceHalfAngle(wall)
  const rows = rowsFor(count, wall)
  const maxYaw = ((Math.min(wall.perRow, count) - 1) / 2) * wall.yawStep + half.yaw
  const maxPitch = ((rows - 1) / 2) * wall.pitchStep + half.pitch
  return maxYaw < halfFovX(aspect) && maxPitch < halfFovY()
}
