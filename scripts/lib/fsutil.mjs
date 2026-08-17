/**
 * Filesystem helpers shared by the deploy scripts.
 *
 * Split out when `bundle.mjs` needed the same three functions `pack.mjs`
 * already had. Two copies of a size formatter is how one of them ends up
 * reporting 16 KB as "0.0 MB" and nobody notices.
 */
import { access, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Total bytes under a path, so a copy can be checked rather than trusted. */
export async function weigh(path) {
  const info = await stat(path).catch(() => null)
  if (!info) return 0
  if (info.isFile()) return info.size
  const entries = await readdir(path, { withFileTypes: true })
  let total = 0
  for (const entry of entries) total += await weigh(join(path, entry.name))
  return total
}

/**
 * Human sizes, scaled to the value.
 *
 * A fixed MB format printed the 16 KB stylesheet bundle as "0.0 MB", which in a
 * tool built to spot missing files reads exactly like a missing file.
 */
export function human(bytes) {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`
  return `${bytes} bytes`
}

/** Every file under `path` whose name matches, depth-first. */
export async function find(path, matches) {
  const info = await stat(path).catch(() => null)
  if (!info) return []
  if (info.isFile()) return matches(path) ? [path] : []
  const entries = await readdir(path, { withFileTypes: true })
  const hits = []
  for (const entry of entries) hits.push(...(await find(join(path, entry.name), matches)))
  return hits
}
