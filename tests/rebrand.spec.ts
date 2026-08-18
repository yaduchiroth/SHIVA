import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'

/**
 * The rebrand holds.
 *
 * Six hundred identifiers renamed across two languages, and it fails in one of
 * two ways, neither of which announces itself. A missed occurrence sits in a
 * file nobody opens again. A broken one leaves a module importing something no
 * longer there — which Python does not notice until the moment it is needed,
 * and for the face recogniser that moment is you standing in front of the
 * camera waiting to be let in.
 *
 * `scripts/check-rebrand.mjs` does the work: compiles every module, refuses any
 * surviving old name outside a short explicit allowlist, and RUNS the parsers
 * that read the renamed markdown. That last step is the one that matters — a
 * find-and-replace breaks front matter far more often than it breaks code, and
 * nothing else here would notice a companion that had silently lost its role.
 *
 * Driven from Playwright so there is one test runner rather than two.
 */
test('the mind compiles, keeps no old names, and still parses its own data', () => {
  test.setTimeout(120_000)
  const result = spawnSync('node', ['scripts/check-rebrand.mjs'], { encoding: 'utf8' })
  // Printed in full on failure: the script names every file and line, and a
  // summary would send someone hunting for what it already knows.
  expect(result.stdout + result.stderr, result.stdout + result.stderr).toContain(
    'The rebrand is complete.',
  )
  expect(result.status).toBe(0)
})
