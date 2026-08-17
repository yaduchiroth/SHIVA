import { expect, test } from '@playwright/test'
// A plain .mjs helper, deliberately not TypeScript: it is imported by
// `scripts/doctor.mjs`, which must run under bare `node` with no build step —
// on a machine where the install may itself be what's broken.
import {
  IMPOSTORS,
  fillCommand,
  inspectEnv,
  isUntouchedTemplate,
} from '../scripts/lib/env-inspect.mjs'

/**
 * The env-file inspector behind `npm run doctor`.
 *
 * Every case here is a way for a file to look correct in an editor and be wrong
 * to the loader. That is the whole category the tool exists for — SHIVA told
 * someone it had no API key while holding one that worked, and the gap between
 * "what I typed" and "what the process got" is where that lives.
 *
 * dotenv is deliberately forgiving about most of this. Being forgiving is what
 * makes it silent, and silent is what made the original problem take an evening.
 */

interface Finding {
  level: 'fail' | 'warn'
  message: string
}
interface Result {
  findings: Finding[]
  values: Map<string, string>
  lineOf: Map<string, number>
}

/** The shape `cp .env.example .env.local` leaves behind. */
const TEMPLATE = [
  '# SHIVA environment',
  'GEMINI_API_KEY=',
  'GEMINI_MODEL=gemini-flash-latest',
  'DEEPGRAM_API_KEY=',
  'GITHUB_TOKEN=',
].join('\n')

const untouched = (text: string, example?: string): boolean =>
  isUntouchedTemplate(inspect(text).values, text, example) as boolean

const inspect = (text: string): Result => inspectEnv(text) as Result
const messages = (r: Result) => r.findings.map((f) => f.message).join('\n')
const fails = (r: Result) => r.findings.filter((f) => f.level === 'fail')

test.describe('a well-formed file', () => {
  test('parses without complaint', () => {
    const result = inspect('GEMINI_API_KEY=abc123\nGEMINI_MODEL=gemini-flash-latest\n')
    expect(result.findings).toHaveLength(0)
    expect(result.values.get('GEMINI_API_KEY')).toBe('abc123')
  })

  test('ignores comments and blank lines', () => {
    const result = inspect('# a comment\n\n  # indented\nKEY=value\n')
    expect(result.findings).toHaveLength(0)
    expect(result.values.size).toBe(1)
  })

  test('keeps "=" inside a value', () => {
    // Base64 and JWT-ish credentials routinely end in padding.
    expect(inspect('K=a=b==\n').values.get('K')).toBe('a=b==')
  })
})

test.describe('duplicate keys', () => {
  test('are reported, with the line that wins', () => {
    // The exact shape produced by `cp .env.example .env.local` followed by
    // pasting the key at the bottom instead of filling in the blank line.
    const result = inspect('GEMINI_API_KEY=\nGEMINI_MODEL=x\nGEMINI_API_KEY=real\n')
    expect(fails(result)).toHaveLength(1)
    expect(messages(result)).toContain('lines 1 and 3')
    expect(messages(result)).toContain('Line 3 wins')
  })

  test('the last assignment is the one reported as the value', () => {
    // Matching dotenv. If this ever diverges, the tool would be describing a
    // configuration the server does not have — worse than not checking at all.
    expect(inspect('K=first\nK=second\n').values.get('K')).toBe('second')
  })

  test('the silently-broken order is caught too', () => {
    // Real key first, empty line later: the empty one wins and everything
    // fails with no visible cause.
    const result = inspect('K=real\nK=\n')
    expect(fails(result)).toHaveLength(1)
    expect(inspect('K=real\nK=\n').values.get('K')).toBe('')
  })
})

test.describe('characters that survive a copy-paste', () => {
  test('a UTF-8 BOM is reported', () => {
    // Invisible in every editor, and it corrupts the FIRST key's name.
    const result = inspect('﻿GEMINI_API_KEY=abc\n')
    expect(fails(result)).toHaveLength(1)
    expect(messages(result)).toContain('BOM')
  })

  test('an RTF document is recognised as such', () => {
    // TextEdit's default format. The file opens and looks right.
    const result = inspect('{\\rtf1\\ansi GEMINI_API_KEY=abc}')
    expect(fails(result)).toHaveLength(1)
    expect(messages(result)).toContain('Make Plain Text')
  })

  test('smart quotes are a failure, not a warning', () => {
    // A rich-text editor substitutes these automatically, and the resulting
    // value cannot even be sent as an HTTP header.
    const result = inspect('K=“abc”\n')
    expect(fails(result).length).toBeGreaterThan(0)
    expect(messages(result)).toContain('non-ASCII')
  })

  test('a quote at one end only is a failure', () => {
    // Half a copied pair. The stray character becomes part of the credential.
    expect(fails(inspect('K="abc\n')).length).toBeGreaterThan(0)
  })

  test('a matched quote pair is stripped, with a warning', () => {
    const result = inspect('K="abc"\n')
    expect(result.values.get('K')).toBe('abc')
    expect(fails(result)).toHaveLength(0)
    expect(messages(result)).toContain('quotes')
  })

  test('trailing whitespace is flagged', () => {
    const result = inspect('K=abc   \n')
    expect(messages(result)).toContain('trailing whitespace')
    // Still usable — dotenv trims — so this is a warning, not a failure.
    expect(fails(result)).toHaveLength(0)
    expect(result.values.get('K')).toBe('abc')
  })

  test('CRLF line endings do not leak into values', () => {
    // A file edited on Windows, or pasted through one.
    expect(inspect('K=abc\r\nJ=def\r\n').values.get('K')).toBe('abc')
  })
})

test.describe('malformed lines', () => {
  test('a line with no "=" is reported rather than skipped quietly', () => {
    const result = inspect('GEMINI_API_KEY abc\n')
    expect(fails(result)).toHaveLength(1)
    expect(messages(result)).toContain('ignored entirely')
  })

  test('an "export" prefix is tolerated and noted', () => {
    const result = inspect('export K=abc\n')
    expect(result.values.get('K')).toBe('abc')
    expect(fails(result)).toHaveLength(0)
  })
})

test.describe('impostor filenames', () => {
  test('covers what macOS actually produces', () => {
    // TextEdit appends .txt without saying so, and Finder hides dotfiles — so
    // the file someone edited is frequently not the file Next.js reads.
    expect(IMPOSTORS).toContain('.env.local.txt')
    expect(IMPOSTORS).toContain('.env.local.rtf')
    expect(IMPOSTORS).toContain('env.local')
  })
})

test.describe('line numbers', () => {
  test('are reported so a message can cite the blank line', () => {
    // "The key is missing" and "line 14 is blank" call for different actions,
    // and the file is 3.6 KB of commentary — being told to add a key that is
    // already sitting there as a blank line is a genuinely annoying dead end.
    const result = inspect('# note\nGEMINI_MODEL=x\nGEMINI_API_KEY=\n')
    expect(result.lineOf.get('GEMINI_API_KEY')).toBe(3)
  })
})

test.describe('an untouched template', () => {
  test('is recognised for what it is', () => {
    // The exact state a fresh setup lands in: `cp .env.example .env.local` and
    // nothing else. Nothing is broken — there is simply one step left — and
    // calling that "no key anywhere" sends someone hunting for a fault.
    expect(untouched(TEMPLATE, TEMPLATE)).toBe(true)
  })

  test('is recognised without the template to compare against', () => {
    // Someone may have trimmed the comments. Every credential line present and
    // blank is the same situation.
    expect(untouched(TEMPLATE)).toBe(true)
  })

  test('stops being reported the moment one key is filled in', () => {
    // The property that matters most. Someone mid-setup has begun, and telling
    // them they have not is both wrong and irritating.
    expect(untouched(TEMPLATE.replace('GEMINI_API_KEY=', 'GEMINI_API_KEY=real'))).toBe(false)
  })

  test('a filled-in key other than the first still counts as started', () => {
    expect(untouched(TEMPLATE.replace('GITHUB_TOKEN=', 'GITHUB_TOKEN=ghp_x'))).toBe(false)
  })

  test('an empty file is not a template', () => {
    // Nothing was copied. That is the plain "no key" case, and it has different
    // advice — add a line, rather than fill one in.
    expect(untouched('')).toBe(false)
    expect(untouched('# just a comment\n')).toBe(false)
  })

  test('a hand-written file with a single blank key is not a template', () => {
    // One blank credential is someone editing, not an unmodified copy.
    expect(untouched('GEMINI_API_KEY=\nGEMINI_MODEL=x\n')).toBe(false)
  })

  test('a file with only non-credential settings is not a template', () => {
    expect(untouched('GEMINI_MODEL=gemini-flash-latest\n')).toBe(false)
  })
})

test.describe('the fix it prints', () => {
  test('uses the -i form the platform actually accepts', () => {
    // BSD sed on macOS requires an argument to -i and GNU sed refuses one, so a
    // single form would be broken for half the people who paste it — and a
    // command that fails is worse than no command, because it reads as another
    // fault in the setup.
    expect(fillCommand('GEMINI_API_KEY', 'darwin')).toContain("-i ''")
    expect(fillCommand('GEMINI_API_KEY', 'linux')).toContain('-i ')
    expect(fillCommand('GEMINI_API_KEY', 'linux')).not.toContain("-i ''")
  })

  test('anchors on the blank line so it cannot overwrite a real key', () => {
    // `^KEY=$` matches only an empty value. Without the anchors, re-running it
    // would clobber a credential someone had already set.
    const command = fillCommand('GEMINI_API_KEY', 'darwin')
    expect(command).toContain('^GEMINI_API_KEY=$')
    expect(command).toContain('.env.local')
  })

  test('names the key it was asked about', () => {
    expect(fillCommand('DEEPGRAM_API_KEY', 'darwin')).toContain('DEEPGRAM_API_KEY')
  })
})
