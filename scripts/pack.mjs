#!/usr/bin/env node
/**
 * Assembles the standalone build into something that actually runs.
 *
 * Next's standalone output is deliberately incomplete: it emits `server.js` and
 * a minimal `node_modules`, and leaves `public/` and `.next/static/` behind.
 * That is a reasonable default — it does not know how you serve static files —
 * but it means the naive deploy produces a site that boots, returns 200, and
 * renders with no CSS and no hand tracking. Nothing errors. It is the single
 * most common way a standalone Next deploy goes wrong.
 *
 * Doing it by hand is two `cp` commands, which is exactly the kind of step that
 * gets skipped on the fourth redeploy at midnight. So it lives here, and it
 * verifies rather than assumes — every copy is checked afterwards, because a
 * missing 7.8 MB model is not visible until someone clicks a button.
 *
 * Run:  BUILD_STANDALONE=1 npm run build && npm run pack
 */
import { cp, readFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, human as mb, weigh } from './lib/fsutil.mjs'
import { inspectEnv, isUntouchedTemplate } from './lib/env-inspect.mjs'
import { explainMissingStandalone, findStandaloneRoot } from './lib/standalone.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = join(ROOT, '.next', 'standalone')

// Located rather than assumed — a build whose workspace root was inferred from
// a lockfile above the project lands one directory deeper, and saying "no
// standalone build" for that is a wrong diagnosis, not a missing one.
const found = await findStandaloneRoot(BASE)
if (!found) {
  console.error(explainMissingStandalone(found, BASE))
  process.exit(1)
}
if (found.nested) {
  console.error(explainMissingStandalone(found, BASE))
  process.exit(1)
}
const OUT = found.path

const line = (s = '') => console.log(s)
const problems = []
const fail = (message) => {
  problems.push(message)
  console.error(`[FAIL] ${message}`)
}

line('Assembling .next/standalone')
line()

// ── The two directories Next leaves behind ───────────────────────────────────
for (const [from, to, label] of [
  [join(ROOT, 'public'), join(OUT, 'public'), 'public/'],
  [join(ROOT, '.next', 'static'), join(OUT, '.next', 'static'), '.next/static/'],
]) {
  if (!(await exists(from))) {
    fail(`${label} does not exist in the project — nothing to copy.`)
    continue
  }
  // Removed first: a stale copy from a previous build is worse than none,
  // because it looks correct and serves last week's assets.
  await rm(to, { recursive: true, force: true })
  await cp(from, to, { recursive: true })

  const before = await weigh(from)
  const after = await weigh(to)
  if (after < before) fail(`${label} copied incompletely (${mb(after)} of ${mb(before)}).`)
  else line(`  ${label.padEnd(16)} ${mb(after)}`)
}

// ── The one nobody expects ───────────────────────────────────────────────────
//
// The standalone server runs with `.next/standalone` as its working directory,
// and Next reads `.env.local` relative to the working directory — so the file
// sitting in the project root is invisible to it. The app boots, reports no API
// key, and every credential appears to have vanished.
//
// Copying it is a convenience, not the recommendation: real environment
// variables set by the host are better, because they keep secrets off the disk
// and out of any backup of the deploy directory. Both are verified to work.
//
// And it reports what is IN the file, not merely that it exists. Announcing
// "copied" for a file full of blank values is the same failure this project has
// already shipped twice: a check on presence, reported as a check on substance.
// Here it would cost an entire deploy cycle — build, 27 MB upload, configure the
// host, restart — to arrive at a status page saying no key was found.
const envSource = join(ROOT, '.env.local')
if (await exists(envSource)) {
  await cp(envSource, join(OUT, '.env.local'))

  const text = await readFile(envSource, 'utf8')
  const { values } = inspectEnv(text)
  const example = await readFile(join(ROOT, '.env.example'), 'utf8').catch(() => undefined)
  const gemini = values.get('GEMINI_API_KEY')

  if (isUntouchedTemplate(values, text, example) || !gemini) {
    // A warning rather than a failure: deploying without a brain is a legitimate
    // choice — the spatial interface, hand tracking and live weather all work —
    // and the app says so honestly rather than pretending to think.
    line('  .env.local       copied, but GEMINI_API_KEY IS BLANK')
    line('                   The deploy will report "no key" and the brain will not')
    line('                   start. Run `npm run doctor` before uploading.')
  } else {
    const extras = ['DEEPGRAM_API_KEY', 'GITHUB_TOKEN'].filter((k) => values.get(k))
    const also = extras.length > 0 ? `, plus ${extras.join(' and ')}` : ''
    line(`  .env.local       copied with GEMINI_API_KEY set${also}`)
  }
} else {
  line('  .env.local       absent — set credentials as environment variables instead')
}

// ── Prune what this app provably never uses ──────────────────────────────────
//
// `sharp` is Next's image optimizer: 33 MB, and the only thing in the whole
// bundle containing compiled native binaries. SHIVA has no images — not one.
// The entire interface is a WebGL canvas plus text, and every panel face is
// drawn with Canvas2D at runtime — so the optimizer is never invoked.
//
// Those binaries are built for the machine that built them, which makes them
// precisely what stops you building on a Mac and uploading to a Linux host.
// Removing them is worth a quarter of the bundle AND the entire portability
// problem.
//
// `images: { unoptimized: true }` does not achieve this on its own, and neither
// does `outputFileTracingExcludes` — both were tried, neither changed the output
// by a byte, because Next copies its own server runtime wholesale rather than
// tracing it. Pruning afterwards does work: verified by serving the full app
// from a bundle with these removed, including every API route.
for (const name of ['@img', 'sharp']) {
  const path = join(OUT, 'node_modules', name)
  if (!(await exists(path))) continue
  const size = await weigh(path)
  await rm(path, { recursive: true, force: true })
  line(`  pruned ${name.padEnd(9)} ${mb(size)} (image optimizer; this app has no images)`)
}

// ── Confirm the things whose absence is silent ───────────────────────────────
line()
line('Checking what fails quietly if missing')
line()

const MODEL = join(OUT, 'public', 'models', 'hand_landmarker.task')
const modelSize = await weigh(MODEL)
if (modelSize > 5_000_000) {
  line(`  hand landmarker  ${mb(modelSize)}`)
} else {
  // Not fatal. The app detects this and falls back to pointer control with a
  // clear message, which is a real deployment choice on a host that blocks the
  // download — so this warns rather than fails.
  line(`  hand landmarker  MISSING — hand tracking will report unavailable.`)
  line(`                   Fix: npm run assets locally, then re-run pack.`)
}

const wasmSize = await weigh(join(OUT, 'public', 'mediapipe'))
if (wasmSize > 1_000_000) line(`  mediapipe wasm   ${mb(wasmSize)}`)
else line('  mediapipe wasm   MISSING — hand tracking cannot start.')

const cssDir = join(OUT, '.next', 'static', 'css')
if (await exists(cssDir)) line(`  stylesheets      ${mb(await weigh(cssDir))}`)
else fail('No stylesheets in .next/static/css — the site will render unstyled.')

line()
if (problems.length > 0) {
  line(`${problems.length} problem(s). The bundle is not ready to deploy.`)
  process.exit(1)
}

line(`Ready. ${mb(await weigh(OUT))} total.`)
line()
line('Start it with:')
line('  cd .next/standalone && PORT=${PORT:-3000} HOSTNAME=0.0.0.0 node server.js')
line()
line('HOSTNAME=0.0.0.0 is not optional behind a reverse proxy — bound to localhost')
line('the process is unreachable and presents as a 502 with a healthy-looking log.')
