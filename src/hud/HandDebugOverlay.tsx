'use client'

import { useEffect, useRef } from 'react'
import { handFrame } from '@/core/hands/handFrame'
import { useGestureStore } from '@/core/store/useGestureStore'
import { getTrackingVideo } from '@/spatial/hands/videoSource'
import { PALETTE } from '@/core/config/palette'
import type { Handedness } from '@/core/types'

/**
 * Live tracking inspector — the mirrored camera feed with the detected skeleton
 * drawn over it, plus the derived gesture values.
 *
 * This exists because "is hand tracking actually working?" is otherwise an
 * unanswerable question. When a gesture doesn't fire there are four
 * indistinguishable explanations: the camera isn't delivering frames, MediaPipe
 * isn't finding the hand, the recognizer is classifying it as something else,
 * or the classification is right but nothing is listening. Watching the
 * skeleton and the live ratios tells you which, in about two seconds.
 *
 * Enabled with `?debug=hands`.
 */

/** MediaPipe's hand topology, as bone chains. */
const BONES: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4], // thumb
  [0, 5, 6, 7, 8], // index
  [0, 9, 10, 11, 12], // middle
  [0, 13, 14, 15, 16], // ring
  [0, 17, 18, 19, 20], // pinky
  [5, 9, 13, 17], // knuckle row
]

const HAND_COLOR: Record<Handedness, string> = {
  left: PALETTE.tracking,
  right: PALETTE.signal,
}

const W = 260
const H = 195

export function HandDebugOverlay() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const status = useGestureStore((s) => s.status)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return

    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)

      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = PALETTE.abyss
      ctx.fillRect(0, 0, W, H)

      // Mirror horizontally to match what the user sees of themselves; an
      // un-mirrored self-view makes every correction go the wrong way.
      ctx.save()
      ctx.translate(W, 0)
      ctx.scale(-1, 1)

      const video = getTrackingVideo()
      if (video && video.readyState >= 2) {
        ctx.globalAlpha = 0.5
        ctx.drawImage(video, 0, 0, W, H)
        ctx.globalAlpha = 1
      }

      for (const handedness of ['left', 'right'] as const) {
        const hand = handFrame[handedness]
        if (!hand.visible) continue

        const color = HAND_COLOR[handedness]
        const at = (i: number) => {
          const p = hand.landmarks[i]
          return p ? { x: p.x * W, y: p.y * H } : null
        }

        ctx.strokeStyle = color
        ctx.lineWidth = 1.5
        for (const chain of BONES) {
          ctx.beginPath()
          chain.forEach((index, i) => {
            const p = at(index)
            if (!p) return
            if (i === 0) ctx.moveTo(p.x, p.y)
            else ctx.lineTo(p.x, p.y)
          })
          ctx.stroke()
        }

        ctx.fillStyle = color
        for (let i = 0; i < 21; i++) {
          const p = at(i)
          if (!p) continue
          // Fingertips drawn larger — they're what every threshold measures.
          const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20
          ctx.beginPath()
          ctx.arc(p.x, p.y, isTip ? 3 : 1.8, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      ctx.restore()
      ctx.font = '10px ui-monospace, monospace'

      let y = 14
      for (const handedness of ['left', 'right'] as const) {
        const hand = handFrame[handedness]
        if (!hand.visible) continue
        ctx.fillStyle = HAND_COLOR[handedness]
        ctx.fillText(
          `${handedness.toUpperCase()[0]} ${hand.gesture.padEnd(5)} pinch ${hand.pinch.toFixed(2)} grab ${hand.grab.toFixed(2)} open ${hand.openness.toFixed(2)}`,
          8,
          y,
        )
        y += 13
      }

      if (handFrame.count === 0) {
        ctx.fillStyle = PALETTE.smoke
        ctx.fillText(status === 'active' ? 'No hand in frame' : `Tracking: ${status}`, 8, y)
      }
    }

    draw()
    return () => cancelAnimationFrame(raf)
  }, [status])

  return (
    <div
      className="glass-surface absolute top-6 left-1/2 -translate-x-1/2 overflow-hidden p-1"
      style={{ pointerEvents: 'none' }}
    >
      <canvas ref={canvas} width={W} height={H} className="block rounded-lg" />
      <div className="text-hud-label px-2 pt-1 pb-0.5 text-center">tracking inspector</div>
    </div>
  )
}
