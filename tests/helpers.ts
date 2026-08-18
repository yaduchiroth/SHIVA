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

/**
 * `quality=low` pins the tier so the governor can't shift it mid-measurement;
 * `capture=1` makes the framebuffer readable, which is off in normal use
 * because preserving it costs frames.
 *
 * `mind=off` because there is no the mind here and there never will be — it is a
 * Python process on a Mac. Attempting the link is correct behaviour and the
 * refusal is handled, but Chromium logs a console error for every failed
 * WebSocket from the network stack, where no JavaScript can suppress it. Those
 * lines would fail the render spec's "no console errors" assertion for a
 * reason that is not a fault. The link's own behaviour when the mind is absent is
 * tested directly, in mind.spec.ts, where it belongs.
 */
export const APP_URL = '/?quality=low&capture=1&mind=off'

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

export interface SharpnessReport {
  /** Mean absolute luminance step between neighbouring pixels, 0–255. */
  meanStep: number
  /** The largest such step found. */
  maxStep: number
  /** Fraction of samples with a step of 8 or more — real edges, not dither. */
  edgeRatio: number
  /** 99.5th percentile step: the strength of the sharpest edges that exist. */
  p995Step: number
}

/**
 * Measures how much fine detail actually survives to the screen.
 *
 * The bug this exists for: depth of field focused at 6.9 units while the orb
 * sat at 11.5, which put the avatar at roughly 93% circle of confusion. Every
 * test in the suite passed. The canvas painted, the colours were varied, no
 * shader errors were logged — and the frame was mush. "Did it draw" and "can
 * you read it" are different questions and the suite was only asking the first.
 *
 * Read at 1:1 from a centre crop, because scaling the canvas down through
 * `drawImage` is itself a blur and would erase the very thing being measured.
 * The centre is where the orb is, and the orb is the densest fine structure in
 * the scene: single-pixel synapse lines against near-black.
 */
export async function sampleSharpness(page: Page, size = 220): Promise<SharpnessReport> {
  return page.evaluate((crop) => {
    const el = document.querySelector('canvas') as HTMLCanvasElement
    const w = Math.min(crop, el.width)
    const h = Math.min(crop, el.height)
    const sx = Math.floor((el.width - w) / 2)
    const sy = Math.floor((el.height - h) / 2)

    const sample = document.createElement('canvas')
    sample.width = w
    sample.height = h
    const ctx = sample.getContext('2d')!
    ctx.drawImage(el, sx, sy, w, h, 0, 0, w, h)
    const { data } = ctx.getImageData(0, 0, w, h)

    const lum = new Float32Array(w * h)
    for (let i = 0; i < lum.length; i++) {
      const p = i * 4
      lum[i] = 0.2126 * data[p]! + 0.7152 * data[p + 1]! + 0.0722 * data[p + 2]!
    }

    const steps: number[] = []
    let total = 0
    let max = 0
    let edges = 0
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = y * w + x
        const step = Math.abs(lum[i + 1]! - lum[i]!) + Math.abs(lum[i + w]! - lum[i]!)
        steps.push(step)
        total += step
        if (step > max) max = step
        if (step >= 8) edges++
      }
    }

    steps.sort((a, b) => a - b)
    return {
      meanStep: total / steps.length,
      maxStep: max,
      edgeRatio: edges / steps.length,
      p995Step: steps[Math.floor(steps.length * 0.995)] ?? 0,
    }
  }, size)
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
    const at = (q: number) =>
      samples[Math.min(samples.length - 1, Math.floor(samples.length * q))] ?? 0

    return {
      frames: samples.length,
      p50: at(0.5),
      p95: at(0.95),
      max: samples[samples.length - 1] ?? 0,
    }
  }, ms)
}
