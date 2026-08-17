/**
 * Reading a `.env` file the way a suspicious person would.
 *
 * Split out of `doctor.mjs` so it can be tested: the failures this catches are
 * all silent ones, and a parser that silently mis-handles a duplicated key
 * would be a strange thing to trust without evidence.
 */

/**
 * Names that are almost certainly a mis-saved `.env.local`.
 *
 * TextEdit on macOS appends `.txt` without saying so, and Finder hides
 * dotfiles — so the file someone edited and saved is frequently not the file
 * Next.js reads. There is nothing to see in the editor, nothing in the
 * terminal, and the app reports a missing key. This is the single most likely
 * cause of the failure that prompted this script, and the hardest to notice.
 */
export const IMPOSTORS = [
  '.env.local.txt',
  '.env.local.rtf',
  '.env.local.rtfd',
  '.env.local.env',
  '.env.locale',
  '.env.local copy',
  'env.local',
  '.env.local ',
]

/**
 * A deliberately strict reader.
 *
 * `dotenv` is forgiving, which is the problem: it silently accepts a value
 * wrapped in quotes, a trailing carriage return, or a duplicated key, and the
 * resulting variable is subtly not what was pasted. Since the whole point here
 * is to find a discrepancy between what someone typed and what the server got,
 * this reports every one of those rather than absorbing them.
 */
export function inspectEnv(text) {
  const findings = []
  const values = new Map()
  const seenAt = new Map()

  // A UTF-8 BOM is invisible everywhere and makes the FIRST key unreadable,
  // because its name silently begins with a zero-width character.
  if (text.charCodeAt(0) === 0xfeff) {
    findings.push({
      level: 'fail',
      message: 'File starts with a UTF-8 BOM — the first key will not parse.',
    })
    text = text.slice(1)
  }

  if (text.startsWith('{\\rtf')) {
    findings.push({
      level: 'fail',
      message:
        'This is an RTF document, not plain text. In TextEdit: Format → Make Plain Text, then save.',
    })
    return { findings, values }
  }

  const lines = text.split(/\r\n|\n|\r/)
  lines.forEach((raw, index) => {
    const number = index + 1
    if (!raw.trim() || raw.trimStart().startsWith('#')) return

    const withoutExport = raw.replace(/^\s*export\s+/, '')
    if (withoutExport !== raw) {
      findings.push({
        level: 'warn',
        message: `line ${number}: starts with "export", which dotenv strips but shells do not. Harmless here.`,
      })
    }

    const eq = withoutExport.indexOf('=')
    if (eq < 0) {
      findings.push({
        level: 'fail',
        message: `line ${number}: no "=" — this line is ignored entirely.`,
      })
      return
    }

    const key = withoutExport.slice(0, eq).trim()
    let value = withoutExport.slice(eq + 1)

    if (/\s$/.test(value) && value.trim()) {
      findings.push({
        level: 'warn',
        message: `line ${number}: ${key} has trailing whitespace, which becomes part of the value.`,
      })
    }
    value = value.trim()

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      findings.push({
        level: 'warn',
        message: `line ${number}: ${key} is wrapped in quotes. dotenv strips them, but a copied quote at only one end would not be.`,
      })
      value = value.slice(1, -1)
    } else if (
      value.startsWith('"') ||
      value.startsWith("'") ||
      value.endsWith('"') ||
      value.endsWith("'")
    ) {
      findings.push({
        level: 'fail',
        message: `line ${number}: ${key} has a quote at one end only — that character is part of the value.`,
      })
    }

    if (/[^\x20-\x7e]/.test(value)) {
      findings.push({
        level: 'fail',
        message: `line ${number}: ${key} contains a non-ASCII character. A smart quote or non-breaking space from a rich-text editor will break the credential.`,
      })
    }

    if (seenAt.has(key)) {
      findings.push({
        level: 'fail',
        message:
          `${key} is set twice, on lines ${seenAt.get(key)} and ${number}. ` +
          `Line ${number} wins. This is what happens after \`cp .env.example .env.local\` ` +
          `if the key is appended at the bottom instead of filling in the blank line — ` +
          `and it breaks silently in the other order, where the empty one wins. Delete one.`,
      })
    }
    seenAt.set(key, number)
    values.set(key, value)
  })

  return { findings, values }
}
