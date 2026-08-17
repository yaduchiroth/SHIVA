/**
 * The camera element the landmarker reads from.
 *
 * Held in a module-level slot rather than React state for the same reason the
 * hand frame is: the debug overlay samples it inside an animation loop, and a
 * store subscription would re-render on every camera lifecycle change for no
 * benefit.
 *
 * The element itself is never attached to the document — it exists only as a
 * frame source. Anything that wants to display it has to draw it, which is what
 * the tracking inspector does.
 */

let element: HTMLVideoElement | null = null

export const setTrackingVideo = (video: HTMLVideoElement | null): void => {
  element = video
}

export const getTrackingVideo = (): HTMLVideoElement | null => element
