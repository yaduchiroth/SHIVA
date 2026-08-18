/**
 * One texture holding every code glyph the orb drifts.
 *
 * The reference implementation gives each of its 1,700 sprites its own 256x32
 * canvas and its own `CanvasTexture`. That is 1,700 GPU textures — roughly
 * 55 MB — and, because a sprite with a unique texture cannot batch, 1,700 draw
 * calls for one layer of decoration.
 *
 * There are only 42 distinct strings. Baking them once into a grid and having
 * instances index into it costs one 1536x256 texture (about 1.5 MB) and one
 * draw call, and looks identical: the variation the eye reads is in position,
 * size and brightness, none of which needs a separate texture to express.
 */

/** Kept from the reference build — machine chatter, deliberately meaningless. */
export const GLYPHS = [
  'sys.init()',
  '0xFF3A',
  'malloc()',
  '>> SCAN',
  'void*',
  'ACK',
  'SYNC OK',
  'ptr_ref',
  'exec()',
  'hash256',
  '::bind',
  'core.0',
  '01101001',
  '10110100',
  '>>> RDY',
  'HEAP 4K',
  'TCP/SYN',
  'mutex.lk',
  'IRQ 0x7',
  'DMA xfer',
  'REG EAX',
  'FAULT 0',
  'kernel.d',
  'pipe |>',
  'chmod +x',
  'fork()',
  'SIGTERM',
  'eth0: UP',
  'AES-256',
  'RSA 4096',
  'TLS 1.3',
  'HTTP/2',
  'latency',
  '200 OK',
  'PATCH /',
  'fn main',
  'use std',
  'impl orb',
  'async {}',
  'spawn()',
  'arc::new',
  '.unwrap',
] as const

/** Cell size in texels. 8:1, which is the aspect the quads are built at. */
export const CELL_W = 256
export const CELL_H = 32
export const COLUMNS = 6

export interface GlyphAtlas {
  canvas: HTMLCanvasElement
  columns: number
  rows: number
  /** Total cells, including any blank remainder — instances index within this. */
  cells: number
}

/**
 * Draws the atlas. Requires a DOM; call it from a client component only.
 *
 * White text on transparent, with no per-glyph colour. Colour is applied in the
 * fragment shader from the orb's accent, so the whole field can shift from
 * bone-white through amber to green as the brain changes state without
 * redrawing a single pixel of this.
 */
export function buildGlyphAtlas(): GlyphAtlas {
  const rows = Math.ceil(GLYPHS.length / COLUMNS)
  const canvas = document.createElement('canvas')
  canvas.width = COLUMNS * CELL_W
  canvas.height = rows * CELL_H

  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.font = `bold ${Math.round(CELL_H * 0.62)}px "Courier New", ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#ffffff'
    GLYPHS.forEach((text, i) => {
      const cx = (i % COLUMNS) * CELL_W + CELL_W / 2
      const cy = Math.floor(i / COLUMNS) * CELL_H + CELL_H / 2
      ctx.fillText(text, cx, cy, CELL_W * 0.92)
    })
  }

  return { canvas, columns: COLUMNS, rows, cells: COLUMNS * rows }
}
