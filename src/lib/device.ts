/**
 * Device capability probing.
 *
 * SHIVA is heavy: transmission materials, god rays, a bloom chain and a neural
 * net all competing for the same GPU. Rather than shipping one setting and
 * hoping, we pick a starting quality tier from what the machine actually is,
 * then let the runtime performance monitor correct from there.
 */

export type QualityTier = 'low' | 'medium' | 'high'

export interface DeviceProfile {
  tier: QualityTier
  renderer: string
  isMobile: boolean
  cores: number
  memoryGB: number | null
  prefersReducedMotion: boolean
  supportsWebGL2: boolean
  /** Tier was pinned via `?quality=`; the runtime governor must not override it. */
  pinned: boolean
}

let cached: DeviceProfile | null = null

export function getDeviceProfile(): DeviceProfile {
  if (cached) return cached
  if (typeof window === 'undefined') {
    return {
      tier: 'medium',
      renderer: 'ssr',
      isMobile: false,
      cores: 4,
      memoryGB: null,
      prefersReducedMotion: false,
      supportsWebGL2: true,
      pinned: false,
    }
  }

  const renderer = probeRenderer()
  // `?quality=low|medium|high` pins the tier. Useful for eyeballing how the
  // interface degrades without hunting for a weaker machine, and it lets the
  // test suite hold quality constant instead of racing the governor.
  const override = new URLSearchParams(window.location.search).get('quality')
  const forced =
    override === 'low' || override === 'medium' || override === 'high' ? override : null
  const isMobile =
    /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent) ||
    // iPadOS reports as desktop Safari; touch points give it away.
    (navigator.maxTouchPoints > 1 && /macintosh/i.test(navigator.userAgent))
  const cores = navigator.hardwareConcurrency ?? 4
  const memoryGB =
    'deviceMemory' in navigator
      ? ((navigator as { deviceMemory?: number }).deviceMemory ?? null)
      : null
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  cached = {
    tier: forced ?? pickTier({ renderer, isMobile, cores, memoryGB }),
    renderer,
    isMobile,
    cores,
    memoryGB,
    prefersReducedMotion,
    supportsWebGL2: renderer !== 'unavailable',
    pinned: forced !== null,
  }
  return cached
}

function probeRenderer(): string {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (!gl) return 'unavailable'
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const name = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER))
    // Release the context immediately — browsers cap concurrent WebGL contexts
    // (often at 16) and a leaked probe context can starve the real canvas.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return name
  } catch {
    return 'unknown'
  }
}

function pickTier(p: {
  renderer: string
  isMobile: boolean
  cores: number
  memoryGB: number | null
}): QualityTier {
  if (p.renderer === 'unavailable') return 'low'

  const r = p.renderer.toLowerCase()
  // Software rasterisers can't sustain even the low tier's effect chain.
  if (r.includes('swiftshader') || r.includes('llvmpipe') || r.includes('software')) return 'low'

  if (p.isMobile) {
    // Apple silicon mobile GPUs handle the medium tier; most others don't.
    return /apple (a1[4-9]|a2\d|m\d)/.test(r) ? 'medium' : 'low'
  }

  if (p.memoryGB !== null && p.memoryGB <= 4) return 'low'
  if (p.cores <= 4) return 'medium'

  // Discrete GPUs get the full stack.
  if (/(rtx|radeon rx|arc a\d|apple m[1-9])/.test(r)) return 'high'
  // Intel integrated graphics: capable, but not of god rays at full resolution.
  if (/(intel|uhd|iris)/.test(r)) return 'medium'

  return p.cores >= 8 ? 'high' : 'medium'
}

/**
 * Whether the framebuffer should be readable outside a frame callback.
 *
 * `preserveDrawingBuffer` stops the driver from discarding the buffer after
 * each present, which costs real performance on some GPUs. It's needed only to
 * screenshot or pixel-sample the canvas, so it's opt-in via `?capture=1` rather
 * than a permanent tax on every user to make testing convenient.
 */
export function isCaptureEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('capture') === '1'
}

/**
 * Whether the live tracking inspector should be shown (`?debug=hands`).
 *
 * Off by default: it draws the camera feed every frame, which is a real cost,
 * and a permanent picture-in-picture of your own hand is not the interface.
 */
export function isHandDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('debug') === 'hands'
}

/**
 * Whether to seed one of every AR surface (`?surfaces=demo`).
 *
 * Judging whether the wall looks right needs a real GPU and a human, and
 * neither is available in CI. This makes that a URL parameter rather than a
 * conversation with the brain.
 */
export function isSurfaceDemoEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('surfaces') === 'demo'
}

/** Secure context is a hard requirement for getUserMedia outside localhost. */
export function canUseCamera(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia)
}
