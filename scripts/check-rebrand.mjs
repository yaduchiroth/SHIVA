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
 * The first version of this file passed twice while both failures were present,
 * and how it managed that is worth writing down, because both mistakes are easy
 * to make again.
 *
 * It searched for the old names with a word boundary — `\bheimdall\b` — which is
 * exactly the pattern the rename itself used. `_` is a word character, so
 * `heimdall_enabled` has no boundary after `heimdall`, and the check asked the
 * same wrong question as the rename and got the same reassuring answer. Twelve
 * environment variables and fourteen attributes sat there in plain sight.
 *
 * And it verified COMPILATION, which is not the same as verifying imports.
 * `compileall` parses a file; it never resolves what that file imports. So
 * `from . import tools_norns`, pointing at a module renamed to `tools_kaala`,
 * compiled perfectly — and would have raised ImportError the first time anyone
 * started the agent. Which is the failure this file's own header describes.
 *
 * So: every module compiles, every relative import resolves against a file that
 * exists, no old name survives anywhere including inside a compound identifier,
 * and the parsers that read the renamed data files are actually run.
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
line('── 2. Every relative import resolves ───────────────────────────')
// The check that compilation cannot do. Parsed with Python's own `ast` rather
// than a regex, because `from . import x as y` is the form that broke and is
// precisely the form a naive pattern misses.
const imports = spawnSync(
  'python3',
  [
    '-c',
    [
      'import ast, pathlib, sys',
      'pkg = pathlib.Path("shiva")',
      'modules = {p.stem for p in pkg.glob("*.py")}',
      'bad = []',
      'for path in sorted(pkg.glob("*.py")):',
      '    tree = ast.parse(path.read_text(), filename=str(path))',
      '    for node in ast.walk(tree):',
      '        if not isinstance(node, ast.ImportFrom) or node.level != 1:',
      '            continue',
      '        names = [node.module] if node.module else [a.name for a in node.names]',
      '        for name in names:',
      '            if name not in modules:',
      '                bad.append(f"{path.name} imports .{name}, which is not a module")',
      'print("\\n".join(bad))',
      'sys.exit(1 if bad else 0)',
    ].join('\n'),
  ],
  { cwd: MIND, encoding: 'utf8' },
)
if (imports.status !== 0) {
  for (const row of (imports.stdout || '').trim().split('\n').filter(Boolean)) problems.push(row)
  line(`  ${(imports.stdout || imports.stderr || '').trim()}`)
} else {
  line('  ok')
}

line()
line('── 3. No retired name survives ─────────────────────────────────')
// Delimited by non-alphanumerics, not by `\b`. The distinction is the whole
// point of this check: `_` is a word character, so `\bheimdall\b` never matched
// `heimdall_enabled` and every compound identifier survived the first pass.
// Dropping the boundary entirely is the opposite error — it finds "odin" inside
// "encoding" and "thor" inside "author". Treating `_` as a delimiter while
// letters and digits are not catches ODIN_STATES and ignores encoding.
const pattern = new RegExp(`(?<![A-Za-z0-9])(${RETIRED.join('|')})(?![A-Za-z0-9])`, 'i')
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
line('── 4. The renamed data files still parse ───────────────────────')
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
line('── 5. Your data survives the rebrand ───────────────────────────')
// The one code path where a mistake destroys something. data/ holds the face
// SHIVA was enrolled with, everything it has been asked to remember, and a
// voiceprint — none of it regenerable, all of it gitignored, so nothing else
// here would notice it had been lost. Run against a temporary directory, so it
// proves the behaviour without going near anyone's actual files.
const migrated = spawnSync(
  'python3',
  [
    '-c',
    [
      'import sys, json, tempfile, pathlib',
      'sys.path.insert(0, ".")',
      'from shiva.migrate import migrate_data',
      'with tempfile.TemporaryDirectory() as d:',
      '    data = pathlib.Path(d)',
      '    face = {"Boss": [[0.125] * 128]}',
      '    (data / "heimdall.json").write_text(json.dumps(face))',
      '    (data / "muninn.json").write_text("{}")',
      '    (data / "bragi.json").write_text("{}")',
      '    moved = migrate_data(data)',
      '    assert len(moved) == 3, moved',
      '    kept = json.loads((data / "nandi.json").read_text())',
      '    assert kept == face, "the embeddings did not survive the rename"',
      '    assert migrate_data(data) == [], "running twice must be a no-op"',
      'with tempfile.TemporaryDirectory() as d:',
      '    data = pathlib.Path(d)',
      '    (data / "heimdall.json").write_text(\'{"stale": 1}\')',
      '    (data / "nandi.json").write_text(\'{"current": 1}\')',
      '    migrate_data(data)',
      '    assert json.loads((data / "nandi.json").read_text()) == {"current": 1}, \\',
      '        "an old file overwrote the one in use"',
      'print("  embeddings preserved, idempotent, refuses to overwrite")',
    ].join('\n'),
  ],
  { cwd: MIND, encoding: 'utf8' },
)
if (migrated.status !== 0) {
  problems.push(`migration failed: ${(migrated.stderr || '').trim().split('\n').pop()}`)
  line(`  ${(migrated.stderr || '').trim()}`)
} else {
  line(migrated.stdout.trimEnd())
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
