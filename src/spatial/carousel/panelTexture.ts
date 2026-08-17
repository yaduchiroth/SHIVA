import * as THREE from 'three'
import type { ModuleDescriptor } from '@/core/types'
import { PALETTE, resolveColor } from '@/core/config/palette'
import { readPanel } from './panelContent'

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
 * Redrawn when the module's live data changes, not per frame. `drawPanel` is
 * cheap by canvas standards but nowhere near frame-budget cheap, so the caller
 * throttles it and skips redraws when the readout is unchanged.
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

/**
 * Draws a module's face into a 2D context.
 *
 * Split out from texture creation so the same routine can repaint an existing
 * canvas when live data arrives — recreating the texture per update would
 * reupload a megabyte to the GPU every few seconds.
 */
export function drawPanel(ctx: CanvasRenderingContext2D, module: ModuleDescriptor, index: number) {
  const accent = resolveColor(module.accent)
  const readout = readPanel(module.id)

  ctx.clearRect(0, 0, W, H)

  const PAD = 68

  // ── Header rule ────────────────────────────────────────────────────────────
  ctx.strokeStyle = INK.steel
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(PAD, 150)
  ctx.lineTo(W - PAD, 150)
  ctx.stroke()

  ctx.fillStyle = accent
  ctx.font = `500 30px ${MONO}`
  ctx.letterSpacing = '6px'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(module.code.toUpperCase(), PAD, 118)

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

  // ── Headline figure ────────────────────────────────────────────────────────
  let y = 372
  if (readout.headline) {
    ctx.fillStyle = accent
    ctx.font = `400 76px ${MONO}`
    ctx.letterSpacing = '-1px'
    ctx.fillText(readout.headline, PAD, y + 56)
    y += 100
  }

  if (readout.caption) {
    ctx.fillStyle = INK.smoke
    ctx.font = `400 28px ${MONO}`
    ctx.letterSpacing = '1px'
    y = wrapText(ctx, readout.caption, PAD, y + 16, W - PAD * 2, 40) + 30
  }

  // ── Chart ──────────────────────────────────────────────────────────────────
  const barTop = Math.max(y, 560)
  const barH = 260
  drawSeries(ctx, readout.series, PAD, barTop, W - PAD * 2, barH, accent, index)

  // ── Rows ───────────────────────────────────────────────────────────────────
  ctx.font = `400 26px ${MONO}`
  ctx.letterSpacing = '2px'
  let rowY = barTop + barH + 58
  for (const row of readout.rows.slice(0, 4)) {
    ctx.fillStyle = INK.ash
    ctx.fillText(row.label.toUpperCase(), PAD, rowY)
    ctx.fillStyle = INK.mist
    const width = ctx.measureText(row.value).width
    ctx.fillText(row.value, W - PAD - width, rowY)
    rowY += 42
  }

  // ── Footer status ──────────────────────────────────────────────────────────
  ctx.strokeStyle = INK.steel
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(PAD, H - 190)
  ctx.lineTo(W - PAD, H - 190)
  ctx.stroke()

  // The status dot never lies about provenance: green only for genuinely live
  // data, amber for a real failure, grey for a source that doesn't exist yet.
  const dot =
    readout.status === 'live'
      ? PALETTE.nominal
      : readout.status === 'error'
        ? PALETTE.caution
        : INK.ash
  ctx.fillStyle = dot
  ctx.beginPath()
  ctx.arc(PAD + 9, H - 128, 9, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = readout.status === 'live' ? INK.mist : INK.ash
  ctx.font = `400 26px ${MONO}`
  ctx.letterSpacing = '5px'
  ctx.fillText(readout.note, PAD + 34, H - 118)
}

/**
 * Bar chart, or a placeholder lattice when there is no data.
 *
 * The placeholder is deliberately flat and grey — it must not be mistakable for
 * a reading. Earlier this drew pseudo-random bars, which looked like data and
 * was exactly the kind of thing that makes a dashboard untrustworthy.
 */
function drawSeries(
  ctx: CanvasRenderingContext2D,
  series: { label: string; value: number }[],
  x: number,
  top: number,
  width: number,
  height: number,
  accent: string,
  seed: number,
) {
  const gap = 8

  if (series.length === 0) {
    const bars = 26
    const barW = (width - gap * (bars - 1)) / bars
    ctx.fillStyle = INK.graphite
    for (let i = 0; i < bars; i++) {
      roundRect(ctx, x + i * (barW + gap), top + height - 24, barW, 24, 3)
      ctx.fill()
    }
    void seed
    return
  }

  const bars = Math.min(series.length, 26)
  const barW = (width - gap * (bars - 1)) / bars
  const values = series.slice(-bars).map((p) => p.value)
  const max = Math.max(...values, 0.0001)
  // Include zero for counts, but not for temperature — a 19-to-23°C range
  // plotted from zero is a flat line that tells you nothing.
  const min = Math.min(...values)
  const floor = min >= 0 && max - min > max * 0.5 ? 0 : min - (max - min) * 0.25
  const span = Math.max(max - floor, 0.0001)

  values.forEach((value, i) => {
    const bx = x + i * (barW + gap)
    ctx.fillStyle = INK.steel
    roundRect(ctx, bx, top, barW, height, 3)
    ctx.fill()

    const h = Math.max(6, ((value - floor) / span) * height)
    // The most recent readings carry the accent; older ones recede.
    ctx.fillStyle = i >= values.length - 6 ? accent : INK.ash
    roundRect(ctx, bx, top + height - h, barW, h, 3)
    ctx.fill()
  })
}

export function createPanelTexture(module: ModuleDescriptor, index: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  drawPanel(ctx, module, index)

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
): number {
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
  // Returned so callers can flow content beneath a variable-height block.
  return cursorY
}
