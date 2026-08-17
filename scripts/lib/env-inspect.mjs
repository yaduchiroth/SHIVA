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
  // Line numbers are surfaced so a message can say "line 14 is blank" rather
  // than "the key is missing" — a distinction that changes what you do about it.
  const lineOf = new Map()

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
    lineOf.set(key, number)
    values.set(key, value)
  })

  return { findings, values, lineOf }
}

/**
 * Credentials the app can actually use. Order matters: the first one is what a
 * "set one to get started" message should name.
 */
const CREDENTIALS = [
  'GEMINI_API_KEY',
  'DEEPGRAM_API_KEY',
  'GITHUB_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
]

/**
 * Has this file been copied from the template and then left alone?
 *
 * Worth its own detection rather than falling through to "no key found",
 * because it is a completely ordinary thing to do — `cp .env.example .env.local`
 * is the documented first step — and it has a one-line fix. Reporting it as a
 * missing key instead sends someone looking for a fault, when nothing is
 * faulty and they simply have one step left.
 *
 * The `example` argument is optional: a byte-identical copy is the clearest
 * signal, but a file where every credential line exists and is blank is the
 * same situation even after someone has reflowed or trimmed the comments.
 *
 * Deliberately returns false once ANY credential has a value. Someone who has
 * filled in one key and not another is mid-setup, not un-started, and telling
 * them they never began would be both wrong and annoying.
 */
export function isUntouchedTemplate(values, text, example) {
  const present = CREDENTIALS.filter((key) => values.has(key))
  if (present.length === 0) return false
  if (present.some((key) => values.get(key))) return false

  if (typeof example === 'string' && text.trim() === example.trim()) return true

  // Every credential the file mentions is blank, and it mentions several — a
  // hand-written file with one blank key is not a template.
  return present.length >= 2
}

/** The command that fills in a key without opening an editor. */
export function fillCommand(key, platform = process.platform) {
  // BSD sed (macOS) requires an argument to -i; GNU sed refuses one.
  const inPlace = platform === 'darwin' ? "-i ''" : '-i'
  return `sed ${inPlace} 's|^${key}=$|${key}=your_key_here|' .env.local`
}
