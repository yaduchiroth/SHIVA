'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { HandLandmarker } from '@mediapipe/tasks-vision'
import { useGestureStore } from '@/core/store/useGestureStore'
import { useSystemStore } from '@/core/store/useSystemStore'
import { getQuality } from '@/core/config/quality'
import { handFrame, resetHand, resetHandFrame } from '@/core/hands/handFrame'
import { emit } from '@/core/events/bus'
import { canUseCamera } from '@/lib/device'
import { HandRecognizer } from './gestureRecognizer'

/**
 * The hand-tracking loop.
 *
 * Runs on its own rAF, deliberately NOT inside R3F's `useFrame`. Inference
 * costs 8–20 ms; running it in the render loop would add that directly to every
 * frame's budget. Here it runs independently, capped by the quality tier, and
 * the renderer samples whatever the latest result happens to be.
 *
 * The MediaPipe module is imported dynamically because it pulls in a WASM
 * loader that has no business in the initial bundle — the OS must boot and be
 * interactive before anyone decides whether to grant camera access.
 */
export function useHandTracking() {
  const setStatus = useGestureStore((s) => s.setStatus)
  const setInputMode = useGestureStore((s) => s.setInputMode)
  const setHandsVisible = useGestureStore((s) => s.setHandsVisible)
  const setGesture = useGestureStore((s) => s.setGesture)
  const setInferenceMs = useGestureStore((s) => s.setInferenceMs)

  const landmarker = useRef<HandLandmarker | null>(null)
  const video = useRef<HTMLVideoElement | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const raf = useRef<number | null>(null)
  const running = useRef(false)

  const recognizers = useRef({
    left: new HandRecognizer('left'),
    right: new HandRecognizer('right'),
  })

  // MediaPipe requires strictly increasing timestamps and throws if one repeats
  // — which happens whenever a frame is sampled twice.
  const lastVideoTime = useRef(-1)
  // Two independent clocks: one paces inference, one paces store writes.
  // Sharing a single ref would make each reset the other's window.
  const lastInference = useRef(0)
  const lastReport = useRef(0)
  const lastHandCount = useRef(0)

  const stop = useCallback(() => {
    running.current = false
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current)
      raf.current = null
    }
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
    if (video.current) {
      video.current.srcObject = null
      video.current.remove()
      video.current = null
    }
    landmarker.current?.close()
    landmarker.current = null
    resetHandFrame()
    setHandsVisible(0)
    setInputMode('pointer')
    setStatus('idle')
  }, [setHandsVisible, setInputMode, setStatus])

  const start = useCallback(async () => {
    if (running.current) return

    if (!canUseCamera()) {
      setStatus(
        'unavailable',
        window.isSecureContext
          ? 'No camera available on this device.'
          : 'Camera requires HTTPS or localhost.',
      )
      return
    }

    setStatus('requesting')

    // ── Camera ───────────────────────────────────────────────────────────────
    let mediaStream: MediaStream
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user',
          // Inference is the bottleneck, not capture. A 640×480/30 feed is
          // plenty for landmarking and far cheaper to decode than 1080p.
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      })
    } catch (err) {
      const denied = err instanceof DOMException && err.name === 'NotAllowedError'
      setStatus(
        denied ? 'denied' : 'unavailable',
        denied
          ? 'Camera access denied — pointer control active.'
          : `Camera unavailable: ${(err as Error).message}`,
      )
      return
    }

    stream.current = mediaStream
    setStatus('loading')

    // ── Model ────────────────────────────────────────────────────────────────
    try {
      const { FilesetResolver, HandLandmarker: Landmarker } = await import(
        '@mediapipe/tasks-vision'
      )
      // Both paths are same-origin, vendored by scripts/fetch-assets.mjs — the
      // COEP header this app sets would block a CDN fetch.
      const fileset = await FilesetResolver.forVisionTasks('/mediapipe')
      landmarker.current = await Landmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: '/models/hand_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        // Higher than detection: once a hand is found, keeping the track stable
        // matters more than re-acquiring it aggressively.
        minTrackingConfidence: 0.6,
      })
    } catch (err) {
      mediaStream.getTracks().forEach((t) => t.stop())
      stream.current = null
      setStatus(
        'unavailable',
        `Hand tracking model failed to load (${(err as Error).message}). Run \`npm run assets\`.`,
      )
      return
    }

    // ── Video element ────────────────────────────────────────────────────────
    // Never attached to the DOM: it exists only as a frame source for MediaPipe.
    const el = document.createElement('video')
    el.srcObject = mediaStream
    el.autoplay = true
    el.muted = true
    el.playsInline = true
    video.current = el

    await new Promise<void>((resolve) => {
      el.onloadeddata = () => resolve()
    })
    await el.play()

    running.current = true
    setStatus('active')
    setInputMode('hand')

    const tick = () => {
      if (!running.current) return
      raf.current = requestAnimationFrame(tick)

      const el = video.current
      const model = landmarker.current
      if (!el || !model || el.readyState < 2) return

      // Skip frames the camera hasn't refreshed. A 30fps feed on a 120Hz
      // display would otherwise be inferred four times per new frame, burning
      // GPU for identical results.
      if (el.currentTime === lastVideoTime.current) return
      lastVideoTime.current = el.currentTime

      // Honour the tier's inference ceiling.
      const { trackingHz } = getQuality(useSystemStore.getState().tier)
      const now = performance.now()
      if (now - lastInference.current < 1000 / trackingHz - 1) return
      lastInference.current = now

      const started = now
      let result
      try {
        result = model.detectForVideo(el, now)
      } catch {
        // A single failed inference is not fatal — drop the frame and continue.
        return
      }
      const elapsed = performance.now() - started
      const timestamp = now / 1000

      // Exponential average: raw per-frame timing is too noisy to display.
      handFrame.inferenceMs = handFrame.inferenceMs * 0.9 + elapsed * 0.1
      handFrame.timestamp = timestamp

      const seen = { left: false, right: false }
      const hands = result.landmarks ?? []

      for (let i = 0; i < hands.length; i++) {
        const landmarks = hands[i]
        if (!landmarks) continue

        // MediaPipe labels handedness from the camera's point of view; the feed
        // is mirrored for the user, so the labels must be swapped to match the
        // hand the user is actually holding up.
        const label = result.handedness?.[i]?.[0]?.categoryName
        const handedness = label === 'Left' ? 'right' : 'left'

        seen[handedness] = true
        recognizers.current[handedness].update(landmarks, timestamp, handFrame[handedness])
      }

      // Reset hands that left the frame, so a stale pose can't linger.
      if (!seen.left && handFrame.left.visible) {
        resetHand('left')
        recognizers.current.left.reset()
      }
      if (!seen.right && handFrame.right.visible) {
        resetHand('right')
        recognizers.current.right.reset()
      }

      const count = (seen.left ? 1 : 0) + (seen.right ? 1 : 0)
      handFrame.count = count

      // Store writes are throttled to ~4 Hz: the HUD is the only consumer and
      // it can't meaningfully show more.
      if (now - lastReport.current > 250) {
        if (count !== lastHandCount.current) {
          setHandsVisible(count)
          if (count > 0 && lastHandCount.current === 0) emit('tracking:acquired', { hands: count })
          if (count === 0 && lastHandCount.current > 0) emit('tracking:lost', {})
          lastHandCount.current = count
        }
        setGesture('left', handFrame.left.gesture)
        setGesture('right', handFrame.right.gesture)
        setInferenceMs(Number(handFrame.inferenceMs.toFixed(1)))
        lastReport.current = now
      }
    }

    raf.current = requestAnimationFrame(tick)
  }, [setGesture, setHandsVisible, setInferenceMs, setInputMode, setStatus])

  useEffect(() => stop, [stop])

  return { start, stop }
}
