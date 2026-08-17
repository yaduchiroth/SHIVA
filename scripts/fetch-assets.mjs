#!/usr/bin/env node
/**
 * Vendors the MediaPipe runtime into `public/` so SHIVA never depends on a
 * third-party CDN at runtime.
 *
 * Two reasons this exists rather than pointing MediaPipe at jsdelivr:
 *   1. Cross-origin isolation. The app sets COEP so the vision WASM can use
 *      threads; a cross-origin script/WASM fetch fails under that policy unless
 *      the CDN opts in with CORP headers. Same-origin sidesteps it entirely.
 *   2. Corporate proxies and locked-down networks routinely block CDNs.
 *
 * WASM is copied out of node_modules (already pinned by the lockfile).
 * The 7.8 MB landmarker model is downloaded once and cached.
 */
import { createWriteStream } from 'node:fs'
import { access, cp, mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WASM_SRC = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const WASM_DEST = join(ROOT, 'public', 'mediapipe')
const MODEL_DEST = join(ROOT, 'public', 'models', 'hand_landmarker.task')
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

// Guards against a truncated download being cached as valid. The float16 model
// is ~7.8 MB; anything meaningfully smaller is a proxy error page.
const MIN_MODEL_BYTES = 5_000_000

const exists = async (p) => {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function copyWasm() {
  if (!(await exists(WASM_SRC))) {
    console.warn('[assets] @mediapipe/tasks-vision not installed yet — skipping WASM copy.')
    return false
  }
  await mkdir(WASM_DEST, { recursive: true })
  await cp(WASM_SRC, WASM_DEST, { recursive: true })
  console.log('[assets] MediaPipe WASM vendored to public/mediapipe/')
  return true
}

async function fetchModel() {
  if (await exists(MODEL_DEST)) {
    const { size } = await stat(MODEL_DEST)
    if (size >= MIN_MODEL_BYTES) {
      console.log('[assets] Hand landmarker model already present — skipping download.')
      return true
    }
    console.warn('[assets] Cached model looks truncated — re-downloading.')
  }

  await mkdir(dirname(MODEL_DEST), { recursive: true })
  console.log('[assets] Downloading hand landmarker model (~7.8 MB)...')

  try {
    const res = await fetch(MODEL_URL)
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(MODEL_DEST))
  } catch (err) {
    // A failed download must not fail `npm install`. The app detects the missing
    // model at runtime and falls back to pointer control with a clear message.
    console.warn(`[assets] Model download failed (${err.message}).`)
    console.warn('[assets] Hand tracking will be unavailable. Re-run `npm run assets` when online.')
    return false
  }

  const { size } = await stat(MODEL_DEST)
  if (size < MIN_MODEL_BYTES) {
    console.warn(`[assets] Downloaded model is only ${size} bytes — treating as failed.`)
    return false
  }

  console.log(`[assets] Model ready (${(size / 1e6).toFixed(1)} MB).`)
  return true
}

const [wasmOk, modelOk] = [await copyWasm(), await fetchModel()]
if (wasmOk && modelOk) console.log('[assets] Hand tracking assets ready.')
