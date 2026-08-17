import type { Page } from '@playwright/test'

/**
 * Shared test utilities.
 *
 * The central problem these solve: CI has no GPU. Chromium falls back to
 * SwiftShader, which rasterises in software at roughly 0.5 frames per second on
 * this scene — three orders of magnitude off real hardware. Any test that
 * asserts a throughput number would be measuring the CI runner, not SHIVA.
 *
 * So the suite splits assertions in two: correctness properties that hold at
 * any speed (does it paint, does it stay consistent, does it leak), and
 * hardware properties that are skipped with a visible reason when there's no
 * real GPU behind the canvas.
 */

/** Tier is pinned so the runtime governor can't shift quality mid-measurement. */
export const APP_URL = '/?quality=low'

export async function bootApp(page: Page): Promise<void> {
  await page.goto(APP_URL)
  await page.waitForSelector('[data-testid="os-ready"]', {
    state: 'attached',
    timeout: 90_000,
  })
}

/** True when the canvas is backed by a software rasteriser. */
export async function isSoftwareRenderer(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('canvas') as HTMLCanvasElement | null
    const gl = el?.getContext('webgl2') ?? el?.getContext('webgl')
    if (!gl) return true
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const name = String(
      ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    ).toLowerCase()
    return /swiftshader|llvmpipe|software|mesa offscreen/.test(name)
  })
}

export interface PaintReport {
  width: number
  height: number
  /** Fraction of sampled pixels differing from the cleared background. */
  paintedRatio: number
  distinctColors: number
}

/**
 * Reads the framebuffer back and measures how much of it is actual content.
 *
 * Compares against the known clear colour rather than an absolute brightness
 * threshold. SHIVA is a deliberately dark interface — most of a correct frame
 * is near-black — so "count bright pixels" would fail on a perfectly good
 * render. "Count pixels that differ from the background" is the property that
 * actually distinguishes a drawn scene from an empty one.
 */
export async function samplePaint(page: Page): Promise<PaintReport> {
  return page.evaluate(() => {
    const el = document.querySelector('canvas') as HTMLCanvasElement
    const sample = document.createElement('canvas')
    sample.width = 200
    sample.height = 130
    const ctx = sample.getContext('2d')!
    ctx.drawImage(el, 0, 0, sample.width, sample.height)
    const { data } = ctx.getImageData(0, 0, sample.width, sample.height)

    // The scene's clear colour, from the `--color-void` token.
    const BG = [6, 6, 7]
    const distinct = new Set<string>()
    let painted = 0

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      // A tolerance of 6 absorbs dithering and 8-bit rounding without letting a
      // flat background register as content.
      if (Math.abs(r - BG[0]!) + Math.abs(g - BG[1]!) + Math.abs(b - BG[2]!) > 6) painted++
      distinct.add(`${r >> 4},${g >> 4},${b >> 4}`)
    }

    return {
      width: el.width,
      height: el.height,
      paintedRatio: painted / (data.length / 4),
      distinctColors: distinct.size,
    }
  })
}

export interface FrameReport {
  frames: number
  p50: number
  p95: number
  max: number
}

/** Samples frame deltas for `ms`, discarding warm-up samples. */
export async function sampleFrames(page: Page, ms: number): Promise<FrameReport> {
  return page.evaluate(async (duration) => {
    const deltas: number[] = []
    let last = performance.now()
    const started = last

    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        deltas.push(now - last)
        last = now
        if (now - started >= duration) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

    const samples = deltas.slice(1).sort((a, b) => a - b)
    const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))] ?? 0

    return {
      frames: samples.length,
      p50: at(0.5),
      p95: at(0.95),
      max: samples[samples.length - 1] ?? 0,
    }
  }, ms)
}
