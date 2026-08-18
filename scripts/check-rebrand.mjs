#!/usr/bin/env node
/**
 * Proves the rebrand is complete, and that the mind still parses.
 *
 * A rename of six hundred identifiers across two languages fails in one of two
 * ways, and neither announces itself. A missed occurrence leaves the old name
 * sitting in a file nobody opens again; a broken one leaves a module that
 * imports something no longer there, which Python does not notice until the
 * moment it is needed — which, for a face recogniser, is the moment you are
 * standing in front of the camera waiting to be let in.
 *
 * So: every module compiles, no old name survives outside a short list of
 * places where it is deliberately mentioned, and the parsers that read the
 * renamed data files are actually run.
 *
 * Run:  npm run rebrand:check
 */
import { spawnSync } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIND = join(ROOT, 'mind')

const line = (s = '') => console.log(s)
const problems = []

/** Names that must not survive anywhere, in any case. */
const RETIRED = [
  'odin',
  'heimdall',
  'huginn',
  'muninn',
  'mimir',
  'bragi',
  'norns',
  'thor',
  'freyja',
  'baldr',
  'idunn',
  'kvasir',
  'valknut',
  'aesir',
]

/**
 * Where an old name is allowed, and why.
 *
 * Deliberately short and deliberately explicit. A regex that excused any
 * mention in a comment would excuse the ones that matter — a stale docstring
 * naming a module that no longer exists is exactly the kind of rot this is
 * meant to catch.
 */
const ALLOWED = [
  // The migration is the one place the old data filenames must appear.
  'mind/shiva/migrate.py',
  // The env-var shim, likewise.
  'mind/shiva/config.py',
  // Documents that explain the rename are entitled to name what was renamed.
  'MIND.md',
  'INTEGRATION.md',
  'DEPLOY.md',
  'README.md',
  'mind/README.md',
  'scripts/check-rebrand.mjs',
]

const TEXT = new Set(['.py', '.ts', '.tsx', '.mjs', '.md', '.sh', '.json', '.txt', '.applescript'])

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (
      ['node_modules', '.next', '.git', '__pycache__', '.venv', 'test-results'].includes(entry.name)
    ) {
      continue
    }
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}

line('── 1. Every module still compiles ──────────────────────────────')
const compiled = spawnSync('python3', ['-m', 'compileall', '-q', join(MIND, 'shiva')], {
  stdio: 'inherit',
})
if (compiled.status !== 0) problems.push('mind/shiva does not compile')
else line('  ok')

line()
line('── 2. No retired name survives ─────────────────────────────────')
const pattern = new RegExp(`\\b(${RETIRED.join('|')})\\b`, 'i')
let scanned = 0
for await (const path of walk(ROOT)) {
  const relative = path.slice(ROOT.length + 1)
  if (!TEXT.has(path.slice(path.lastIndexOf('.')))) continue
  if (ALLOWED.includes(relative)) continue
  if ((await stat(path)).size > 2_000_000) continue
  scanned++
  const text = await readFile(path, 'utf8').catch(() => '')
  for (const [index, row] of text.split('\n').entries()) {
    const hit = pattern.exec(row)
    if (hit) problems.push(`${relative}:${index + 1} still says "${hit[1]}"`)
  }
}
line(`  scanned ${scanned} files`)

line()
line('── 3. The renamed data files still parse ───────────────────────')
// Run for real, not mocked. A find-and-replace breaks front matter and
// markdown far more often than it breaks code, and this is the only step that
// would notice.
const parsed = spawnSync(
  'python3',
  [
    '-c',
    [
      'import sys; sys.path.insert(0, ".")',
      'from shiva import companions as C',
      'roster = C.load()',
      'assert len(roster) == 5, f"expected 5 companions, got {len(roster)}"',
      'names = sorted(c.name for c in roster)',
      'expected = ["Brihaspati", "Ganesha", "Lakshmi", "Narada", "Saraswati"]',
      'assert names == expected, f"roster is {names}"',
      'assert all(c.role and c.color and c.trigger for c in roster), "a companion lost its front matter"',
      'from shiva.knowledge import Knowledge',
      'assert Knowledge().docs, "knowledge index is empty"',
      'print("  5 companions, front matter intact, knowledge indexed")',
    ].join('\n'),
  ],
  { cwd: MIND, encoding: 'utf8' },
)
if (parsed.status !== 0) {
  problems.push(
    `parsers failed: ${(parsed.stderr || parsed.stdout || '').trim().split('\n').pop()}`,
  )
  line(`  ${(parsed.stderr || '').trim()}`)
} else {
  line(parsed.stdout.trimEnd())
}

line()
if (problems.length === 0) {
  line('The rebrand is complete.')
  process.exit(0)
}
line(`${problems.length} problem(s):`)
for (const problem of problems.slice(0, 40)) line(`  • ${problem}`)
if (problems.length > 40) line(`  … and ${problems.length - 40} more`)
process.exit(1)
