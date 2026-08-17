/**
 * Finding the standalone build, rather than asserting where it should be.
 *
 * `.next/standalone/server.js` is the right answer almost always, and the deploy
 * scripts used to simply require it. When it was absent they blamed the missing
 * `BUILD_STANDALONE` flag — which was a reasonable guess, and on a real machine
 * it was wrong in the most annoying way possible: it told someone to run the
 * command they had just run.
 *
 * What had actually happened was that Next inferred the workspace root from a
 * stray lockfile in a parent directory, and standalone output preserves the path
 * from that root, so everything landed one directory deeper. `next.config.ts`
 * now pins the root and this cannot recur here — but a wrong diagnosis is worse
 * than no diagnosis, so the scripts locate the build and, if it turns out to be
 * nested, say exactly that.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { exists } from './fsutil.mjs'

/**
 * A standalone root is a directory holding both `server.js` and `.next`.
 *
 * Both conditions are needed. `server.js` alone is not distinctive — there are
 * dozens inside `node_modules`, including react-dom's and several of Next's own.
 */
async function isStandaloneRoot(path) {
  return (await exists(join(path, 'server.js'))) && (await exists(join(path, '.next')))
}

/**
 * Locates the standalone build under `.next/standalone`.
 *
 * @returns `{ path, nested }`, or null when there is no build at all.
 *          `nested` is true when it is not directly at the expected location,
 *          which is the signal that the workspace root was inferred wrongly.
 */
export async function findStandaloneRoot(base) {
  if (!(await exists(base))) return null
  if (await isStandaloneRoot(base)) return { path: base, nested: false }

  // Breadth-first, and never into `node_modules` — that is where all the
  // decoy `server.js` files live, and it is by far the largest subtree.
  const queue = [base]
  while (queue.length > 0) {
    const current = queue.shift()
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.next') continue
      const path = join(current, entry.name)
      if (await isStandaloneRoot(path)) return { path, nested: true }
      queue.push(path)
    }
  }
  return null
}

/**
 * What to print when there is no usable build at the expected path.
 *
 * Two genuinely different situations, and conflating them is what made the
 * original message misleading.
 */
export function explainMissingStandalone(found, base) {
  if (found?.nested) {
    const relative = found.path.slice(base.length + 1)
    return [
      `The standalone build is nested: .next/standalone/${relative}/server.js`,
      '',
      'That happens when Next infers the workspace root from a lockfile ABOVE',
      'this project — standalone output preserves the path from that root. Check',
      'the build log for "inferred your workspace root".',
      '',
      'next.config.ts pins outputFileTracingRoot to prevent this. If you are',
      'seeing it, the build ran against an older config — rebuild.',
    ].join('\n')
  }

  return [
    'No standalone build under .next/standalone.',
    '',
    'An ordinary `npm run build` does not produce one — the output mode is gated',
    'behind BUILD_STANDALONE so local development is untouched.',
    '',
    '  npm run build:standalone',
  ].join('\n')
}

/** Kept for symmetry with the checks above; used by the scripts' preflight. */
export const standaloneStat = stat
