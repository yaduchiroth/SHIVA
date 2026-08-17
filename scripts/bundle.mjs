#!/usr/bin/env node
/**
 * Produces one uploadable archive for a managed Node host.
 *
 * This exists because building on the host is the wrong move for Hostinger's
 * hPanel Node.js app, and the reasons are not obvious until you hit them:
 *
 *   - `next build` on this project compiles three.js, React Three Fiber and a
 *     postprocessing chain. On a memory-constrained shared plan that is a
 *     realistic OOM kill, and an OOM during a Next build presents as a
 *     truncated log rather than an error that names the cause.
 *   - Building needs the repo plus roughly a gigabyte of `node_modules` on the
 *     server, when the finished bundle is 126 MB and carries its own.
 *   - `postinstall` fetches a 7.8 MB model from Google. A host that blocks
 *     outbound traffic costs you hand tracking, silently.
 *
 * Standalone output exists precisely so none of that has to happen on the
 * server. Build where it is known to build; upload the result finished.
 *
 * The archive is laid out so its CONTENTS become the application root. That is
 * deliberate: Next's standalone `server.js` calls `process.chdir(__dirname)`, so
 * everything it looks for — `public/`, `.next/static/`, `.env.local` — must sit
 * beside it. Making the app root be that directory means the layout the host
 * expects and the layout the server expects are the same one, and the
 * `.env.local`-in-the-wrong-directory trap cannot happen.
 *
 * Run:  npm run bundle          (builds, packs, archives)
 *       npm run bundle -- --no-env   (omit credentials from the archive)
 */
import { spawnSync } from 'node:child_process'
import { rm, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { find, human, weigh } from './lib/fsutil.mjs'
import { explainMissingStandalone, findStandaloneRoot } from './lib/standalone.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = join(ROOT, '.next', 'standalone')
const ARCHIVE = join(ROOT, 'shiva-deploy.tar.gz')

const line = (s = '') => console.log(s)
const section = (title) => {
  line()
  line('─'.repeat(66))
  line(title)
  line('─'.repeat(66))
}

const withEnv = !process.argv.includes('--no-env')

// ── The bundle must be a standalone build, in the place everything expects ───
const found = await findStandaloneRoot(BASE)
if (!found || found.nested) {
  console.error(explainMissingStandalone(found, BASE))
  process.exit(1)
}
const OUT = found.path

// ── Assembly and verification live in pack; do not duplicate them ────────────
section('1. Assembling and verifying')
const packed = spawnSync(process.execPath, [join(ROOT, 'scripts', 'pack.mjs')], {
  stdio: 'inherit',
})
if (packed.status !== 0) {
  console.error('\npack reported problems — not bundling an incomplete build.')
  process.exit(1)
}

// ── Native binaries would not survive a macOS → Linux upload ─────────────────
section('2. Checking the bundle is portable')

// Everything this app needs at runtime is pure JavaScript — three, React, and
// Next's server — so this should come back empty. It is checked rather than
// assumed because the whole premise of building elsewhere and uploading rests
// on it, and a native binary built for Darwin fails on Linux at require() time
// with a message about the file format, not about the platform.
const natives = await find(join(OUT, 'node_modules'), (p) => p.endsWith('.node'))
if (natives.length === 0) {
  line('  No native binaries — safe to build on one platform and run on another.')
} else {
  line(`  ${natives.length} native binary file(s) found:`)
  for (const path of natives.slice(0, 5)) line(`    ${path.slice(OUT.length + 1)}`)
  line()
  line('  These are compiled for the machine that built them. If your server runs a')
  line('  different OS or architecture, build there instead — see DEPLOY.md.')
}

// ── Archive ──────────────────────────────────────────────────────────────────
section('3. Archiving')

await rm(ARCHIVE, { force: true })

// `-C` so paths inside the archive are relative to the standalone directory:
// extracting puts `server.js` at the top of wherever you are, which is what
// makes "extract into the app root" work without a nested directory.
const exclude = withEnv ? [] : ['--exclude=./.env.local']
const tar = spawnSync('tar', ['-czf', ARCHIVE, ...exclude, '-C', OUT, '.'], { stdio: 'inherit' })

if (tar.error || tar.status !== 0) {
  console.error('\n`tar` is unavailable or failed.')
  console.error('Compress the contents of .next/standalone by hand instead —')
  console.error('the CONTENTS, not the directory, so server.js is at the archive root.')
  process.exit(1)
}

const size = (await stat(ARCHIVE)).size
line()
line(`  shiva-deploy.tar.gz   ${human(size)}   (from ${human(await weigh(OUT))} unpacked)`)

if (withEnv) {
  line()
  line('  NOTE: this archive contains .env.local, so it holds your API keys.')
  line('  Do not share it, and delete it once uploaded. Use --no-env to omit them')
  line('  and set credentials in the host panel instead.')
}

// ── What to do with it ───────────────────────────────────────────────────────
section('Next steps — hPanel Node.js app')

line('1. Upload shiva-deploy.tar.gz  (hPanel → File Manager, or SFTP)')
line('2. Extract it into the directory you will use as the application root,')
line('   e.g. ~/shiva — so that server.js sits directly inside it, not nested.')
line('3. hPanel → Advanced → Node.js:')
line('     Application root    ~/shiva')
line('     Startup file        server.js')
line('     Node version        20 or 22')
line('   Leave PORT alone — the panel assigns it.')
line('4. Restart the app, then work down the checks in DEPLOY.md §5.')
line()
line('Do NOT run npm install on the server. The bundle carries its own')
line('node_modules, and installing would pull a different dependency tree over it.')
line()
