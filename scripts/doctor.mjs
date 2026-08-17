#!/usr/bin/env node
/**
 * Finds out why SHIVA can't reach its brain.
 *
 * This exists because the app told someone "No API key — set GEMINI_API_KEY in
 * .env.local" while holding a key that was, at that exact moment, working
 * perfectly. The message was not lying about what it checked; it was lying
 * about what that check meant. `configured` was `Boolean(process.env.KEY)` —
 * an assertion about a string, presented as an assertion about the world.
 *
 * Three completely different problems arrive looking identical from the UI:
 * the env file not loading, a key Google rejects, and a key whose project
 * hasn't enabled the API. Only the first is the user's fault, and only the
 * third has a fix that involves Google's console. Telling them apart from a
 * status bar is impossible, so this does it from the command line instead.
 *
 * Run:  npm run doctor
 *
 * It prints no secrets — only a key's first three characters and its length.
 * The whole output is safe to paste back.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IMPOSTORS, fillCommand, inspectEnv, isUntouchedTemplate } from './lib/env-inspect.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const line = (s = '') => console.log(s)
const section = (title) => {
  line()
  line('─'.repeat(66))
  line(title)
  line('─'.repeat(66))
}

const OK = '  ok  '
const BAD = ' FAIL '
const WARN = ' warn '

/** Anything that would stop the run being usable. Drives the exit code. */
const failures = []
const fail = (message) => {
  failures.push(message)
  line(`[${BAD}] ${message}`)
}

/**
 * Describes a secret without revealing it.
 *
 * Enough to spot a truncated paste, a swapped key or a stray quote; not enough
 * to use. Everything printed by this script goes through here.
 */
const shape = (value) => (value ? `${value.slice(0, 3)}… (${value.length} chars)` : '(empty)')

// ── 1. Which files exist, and which ones only look like they do ──────────────
section('1. Environment files')

let entries = []
try {
  entries = await readdir(ROOT)
} catch (err) {
  fail(`Cannot read the project directory: ${err.message}`)
}

const envFiles = entries.filter(
  (name) => name.toLowerCase().startsWith('.env') || name === 'env.local',
)

if (envFiles.length === 0) {
  fail('No .env files at all. Run:  cp .env.example .env.local')
} else {
  for (const name of envFiles.sort()) {
    const path = join(ROOT, name)
    const { size } = await stat(path).catch(() => ({ size: 0 }))
    line(`  ${name.padEnd(22)} ${String(size).padStart(6)} bytes   ${path}`)
  }
}

for (const impostor of IMPOSTORS) {
  if (entries.includes(impostor)) {
    fail(
      `Found "${impostor}". Next.js only reads ".env.local" — rename it:\n` +
        `         mv '${impostor}' .env.local`,
    )
  }
}

const hasEnvLocal = entries.includes('.env.local')
if (!hasEnvLocal && envFiles.length > 0) {
  fail('No .env.local. Only .env.local is read for local secrets — copy .env.example to it.')
}

// ── 2. Is the file actually parseable, and is each key well formed? ──────────
section('2. .env.local contents')

let values = new Map()
let lineOf = new Map()
/** True when the file is the template, copied and not yet filled in. */
let untouched = false

if (hasEnvLocal) {
  const text = await readFile(join(ROOT, '.env.local'), 'utf8').catch(() => null)
  const example = await readFile(join(ROOT, '.env.example'), 'utf8').catch(() => null)
  if (text === null) {
    fail('.env.local exists but could not be read.')
  } else {
    const result = inspectEnv(text)
    values = result.values
    lineOf = result.lineOf ?? new Map()
    untouched = isUntouchedTemplate(values, text, example ?? undefined)
    for (const finding of result.findings) {
      if (finding.level === 'fail') fail(finding.message)
      else line(`[${WARN}] ${finding.message}`)
    }
    if (result.findings.length === 0) line(`[${OK}] Parses cleanly.`)
    line()
    for (const key of ['GEMINI_API_KEY', 'GEMINI_MODEL', 'DEEPGRAM_API_KEY', 'GITHUB_TOKEN']) {
      const value = values.get(key)
      const shown = key.endsWith('MODEL') ? (value ?? '(unset)') : shape(value)
      line(`  ${key.padEnd(20)} ${values.has(key) ? shown : '(not present)'}`)
    }
  }
}

// The environment beats the file. Worth saying out loud: an exported shell
// variable silently wins over the file someone is busy editing, which looks
// exactly like the file being ignored.
const geminiKey = process.env.GEMINI_API_KEY?.trim() || values.get('GEMINI_API_KEY') || ''
if (
  process.env.GEMINI_API_KEY &&
  values.get('GEMINI_API_KEY') !== process.env.GEMINI_API_KEY.trim()
) {
  line()
  line(`[${WARN}] GEMINI_API_KEY is also set in your shell, and the shell wins over .env.local.`)
}

if (!geminiKey) {
  // One cause, one failure. Reporting both "the template is untouched" and "no
  // key anywhere" describes the same fact twice and makes the fix look like two
  // problems.
  if (untouched) {
    fail(
      '.env.local is the template, copied but not filled in — every credential ' +
        'line is still blank.\n' +
        '         Nothing is broken; there is one step left. Without opening an editor:\n' +
        `           ${fillCommand('GEMINI_API_KEY')}\n` +
        '         Get a key at https://aistudio.google.com/apikey',
    )
  } else if (lineOf.has('GEMINI_API_KEY')) {
    // The line is there and empty. "Missing" would send someone to add a key
    // that is already present as a blank — in a 3.6 KB file of commentary,
    // which is a genuinely annoying thing to be told.
    fail(
      `GEMINI_API_KEY is on line ${lineOf.get('GEMINI_API_KEY')} of .env.local but has no value.\n` +
        `         Fill it in, or run:  ${fillCommand('GEMINI_API_KEY')}`,
    )
  } else {
    fail(
      'No GEMINI_API_KEY in .env.local or the environment. The brain cannot start.\n' +
        '         Add a line:  GEMINI_API_KEY=your_key_here',
    )
  }
}

// ── 3. Ask Google, rather than assuming ──────────────────────────────────────
section('3. Does Google accept the key?')

const model = values.get('GEMINI_MODEL') || process.env.GEMINI_MODEL || 'gemini-flash-latest'
const FALLBACKS = ['gemini-flash-lite-latest', 'gemini-3-flash-preview']
const TTS = 'gemini-2.5-flash-preview-tts'

// Sending a non-ASCII value as a header throws rather than returning a status,
// and the resulting message is about ByteStrings — which tells nobody anything.
// The parse step already reported the real problem; don't bury it under this.
const keyIsSendable = /^[\x20-\x7e]*$/.test(geminiKey)

if (!geminiKey) {
  line('  Skipped — no key to test.')
} else if (!keyIsSendable) {
  line('  Skipped — the key contains characters that cannot be sent in a header.')
  line('  Fix the non-ASCII character reported above first.')
} else {
  try {
    // Listing models is free, read-only and spends no quota, which makes it the
    // right probe: it distinguishes "key rejected" from "key fine, model gone"
    // without generating a single token.
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': geminiKey },
      signal: AbortSignal.timeout(15000),
    })
    line(`  GET /v1beta/models → HTTP ${res.status}`)

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      let detail = body.slice(0, 500)
      try {
        detail = JSON.parse(body).error?.message ?? detail
      } catch {
        /* not JSON — the raw body is the best we have */
      }
      // Printed in full. Google puts the sentence naming the fix at the END of
      // its message, so truncating is exactly the wrong economy.
      fail(`Google rejected the key:\n         ${detail}`)
    } else {
      const body = await res.json()
      const names = new Set((body.models ?? []).map((m) => String(m.name).replace(/^models\//, '')))
      line(`[${OK}] Key authenticates. ${names.size} models available.`)
      line()
      for (const candidate of [model, ...FALLBACKS, TTS]) {
        const label = candidate === model ? `${candidate}  (configured)` : candidate
        if (names.has(candidate)) line(`  [${OK}] ${label}`)
        else if (candidate === model)
          fail(`Configured model "${candidate}" is not available to this key.`)
        else
          line(`  [${WARN}] ${label} — unavailable; the fallback chain is shorter than it looks.`)
      }
    }
  } catch (err) {
    fail(`Could not reach Google: ${err.message}`)
  }
}

/**
 * Did this response actually come from Deepgram?
 *
 * A proxy or gateway that denies the host answers with its own 403 and its own
 * body. Deepgram's errors are JSON carrying `err_code`/`err_msg`; anything else
 * at this URL came from a middlebox.
 */
function isDeepgramResponse(body) {
  try {
    const parsed = JSON.parse(body)
    return (
      typeof parsed === 'object' && parsed !== null && ('err_code' in parsed || 'err_msg' in parsed)
    )
  } catch {
    return false
  }
}

// ── 4. Deepgram: shape only ──────────────────────────────────────────────────
section('4. Deepgram (live voice)')

const deepgram = process.env.DEEPGRAM_API_KEY?.trim() || values.get('DEEPGRAM_API_KEY') || ''
if (!deepgram) {
  // Not a failure. Live voice is optional and the wake-word path works without it.
  line('  Not set — the Live button stays disabled, everything else works.')
  if (untouched) line(`  To enable it later:  ${fillCommand('DEEPGRAM_API_KEY')}`)
} else {
  line(`  Present: ${shape(deepgram)}`)
  try {
    const res = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${deepgram}` },
      signal: AbortSignal.timeout(15000),
    })
    const body = await res.text().catch(() => '')
    line(`  GET /v1/projects → HTTP ${res.status}`)

    if (res.ok) {
      line(`[${OK}] Deepgram accepts the key.`)
    } else if (isDeepgramResponse(body)) {
      let detail = body.slice(0, 300)
      try {
        const parsed = JSON.parse(body)
        detail = parsed.err_msg ?? parsed.message ?? detail
      } catch {
        /* keep the raw body */
      }
      fail(`Deepgram rejected the key: ${detail}`)
    } else {
      // A 403 from something between here and Deepgram is not Deepgram saying
      // no. Corporate proxies and sandboxed networks both return one, and
      // reporting it as a bad key sends someone to rotate a credential that
      // was never the problem — which is precisely the mistake this whole
      // script was written to stop making.
      line(`[${WARN}] Something between here and Deepgram answered, not Deepgram itself:`)
      line(`         ${body.slice(0, 200) || '(no body)'}`)
      line('         The key may be fine. Try again from a network without a proxy.')
    }
  } catch (err) {
    // The build container is denied egress to Deepgram; on a normal machine
    // this is a real result. Either way it is not worth failing the run over.
    line(`[${WARN}] Could not reach Deepgram: ${err.message}`)
  }
}

// ── Verdict ──────────────────────────────────────────────────────────────────
section(failures.length === 0 ? 'All good' : `${failures.length} problem(s) found`)

if (failures.length === 0) {
  line('The brain should work. If the app still says it has no key, the server is')
  line('running with older environment: stop `npm run dev` and start it again, since')
  line('env is read once at boot.')
} else {
  for (const message of failures) line(`  • ${message.split('\n')[0]}`)
  line()
  line('Fix these, then restart `npm run dev` — env is read at boot, so editing')
  line('.env.local while the server runs may not take effect.')
}
line()

process.exit(failures.length === 0 ? 0 : 1)
