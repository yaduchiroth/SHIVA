import * as THREE from 'three'
import type { ModuleDescriptor } from '@/core/types'
import { PALETTE, resolveColor } from '@/core/config/palette'

/**
 * Panel faces, drawn with Canvas2D into a texture.
 *
 * The alternative was troika/drei `<Text>`, which is rejected here because it
 * fetches its default typeface from a Google CDN at runtime — a network
 * dependency that breaks offline, and a cross-origin fetch that the COEP header
 * this app sets would block anyway. Canvas2D uses locally-installed fonts, has
 * no network path, and gives precise control over the dense instrument-panel
 * layout the aesthetic calls for.
 *
 * Each texture is drawn once at construction. Live values are drawn into a
 * separate, much smaller readout texture that can be redrawn cheaply.
 */

const W = 1024
const H = 1408

// Canvas2D can't read CSS custom properties, so the literals come from the
// shared palette rather than being duplicated here.
const INK = PALETTE

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

export function createPanelTexture(module: ModuleDescriptor, index: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const accent = resolveColor(module.accent)

  ctx.clearRect(0, 0, W, H)

  const PAD = 68

  // ── Header rule ────────────────────────────────────────────────────────────
  ctx.strokeStyle = INK.steel
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(PAD, 150)
  ctx.lineTo(W - PAD, 150)
  ctx.stroke()

  // Module code, top-left — the FUI identifier.
  ctx.fillStyle = accent
  ctx.font = `500 30px ${MONO}`
  ctx.letterSpacing = '6px'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(module.code.toUpperCase(), PAD, 118)

  // Slot index, top-right.
  ctx.fillStyle = INK.ash
  ctx.font = `400 26px ${MONO}`
  ctx.letterSpacing = '4px'
  const slot = `${String(index + 1).padStart(2, '0')}`
  ctx.fillText(slot, W - PAD - ctx.measureText(slot).width, 118)

  // ── Title ──────────────────────────────────────────────────────────────────
  ctx.fillStyle = INK.bone
  ctx.font = `300 104px ${MONO}`
  ctx.letterSpacing = '-2px'
  ctx.fillText(module.label.toUpperCase(), PAD, 300)

  // ── Summary, wrapped ───────────────────────────────────────────────────────
  ctx.fillStyle = INK.smoke
  ctx.font = `400 30px ${MONO}`
  ctx.letterSpacing = '1px'
  wrapText(ctx, module.summary, PAD, 372, W - PAD * 2, 44)

  // ── Instrument block ───────────────────────────────────────────────────────
  // A bar field: pure ornament, but ornament with a consistent grammar reads as
  // instrumentation rather than decoration.
  const barTop = 540
  const barH = 300
  const bars = 26
  const gap = 8
  const barW = (W - PAD * 2 - gap * (bars - 1)) / bars

  for (let i = 0; i < bars; i++) {
    // Deterministic pseudo-random so a panel looks identical across reloads —
    // a readout that reshuffles every mount reads as noise, not data.
    const seed = Math.sin((index + 1) * 12.9898 + i * 78.233) * 43758.5453
    const v = Math.abs(seed - Math.floor(seed))
    const h = 30 + v * (barH - 30)
    const x = PAD + i * (barW + gap)

    ctx.fillStyle = INK.steel
    roundRect(ctx, x, barTop, barW, barH, 3)
    ctx.fill()

    ctx.fillStyle = i > bars - 7 ? accent : INK.ash
    roundRect(ctx, x, barTop + barH - h, barW, h, 3)
    ctx.fill()
  }

  // ── Footer: status line ────────────────────────────────────────────────────
  ctx.strokeStyle = INK.steel
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(PAD, H - 190)
  ctx.lineTo(W - PAD, H - 190)
  ctx.stroke()

  // Honest labelling: panels whose data source lands in a later phase say so,
  // rather than showing invented numbers that look live.
  const live = module.liveIn === 1
  ctx.fillStyle = live ? PALETTE.nominal : INK.ash
  ctx.beginPath()
  ctx.arc(PAD + 9, H - 128, 9, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = live ? INK.mist : INK.ash
  ctx.font = `400 26px ${MONO}`
  ctx.letterSpacing = '5px'
  ctx.fillText(live ? 'LIVE' : `AWAITING PHASE ${module.liveIn}`, PAD + 34, H - 118)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  texture.needsUpdate = true
  return texture
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): void {
  let line = ''
  let cursorY = y
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word
    if (ctx.measureText(candidate).width > maxWidth && line) {
      ctx.fillText(line, x, cursorY)
      line = word
      cursorY += lineHeight
    } else {
      line = candidate
    }
  }
  if (line) ctx.fillText(line, x, cursorY)
}
