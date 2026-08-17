#!/usr/bin/env node
/**
 * Discovers Deepgram's Voice Agent API shape.
 *
 * This exists because the build environment cannot reach Deepgram, so the
 * integration would otherwise be written from pre-cutoff memory. That is
 * precisely how three bugs got shipped against Gemini this week: a model that
 * had been retired, a frame separator that was CRLF rather than LF, and a
 * response shape that carried no text. None were visible to reasoning; all
 * three showed up instantly against the real API.
 *
 * So this probe does not assume. It tries each plausible endpoint, auth method
 * and settings schema in turn and reports which one the service actually
 * accepts — including the exact error text when one is rejected, because
 * Deepgram's validation errors name the correct field.
 *
 * Run:  node scripts/probe-deepgram.mjs
 * Needs DEEPGRAM_API_KEY in the environment or in .env.local.
 *
 * It prints no secrets. Paste the whole output back safely.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadKey() {
  if (process.env.DEEPGRAM_API_KEY) return process.env.DEEPGRAM_API_KEY.trim()
  try {
    const env = readFileSync(join(ROOT, '.env.local'), 'utf8')
    const match = /^DEEPGRAM_API_KEY=(.*)$/m.exec(env)
    if (match) return match[1].trim()
  } catch {
    /* no .env.local */
  }
  return null
}

const KEY = loadKey()
if (!KEY) {
  console.error('No DEEPGRAM_API_KEY found.')
  console.error('Add it to .env.local:  DEEPGRAM_API_KEY=your_key_here')
  process.exit(1)
}

const line = (s = '') => console.log(s)
const section = (title) => {
  line()
  line('─'.repeat(64))
  line(title)
  line('─'.repeat(64))
}

/** Truncates and strips anything that could carry a secret. */
const safe = (value, max = 400) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (text ?? '').replace(new RegExp(KEY, 'g'), '<redacted>').slice(0, max)
}

// ── 1. Does the key authenticate at all? ─────────────────────────────────────
section('1. REST auth')
let projectId = null
try {
  const res = await fetch('https://api.deepgram.com/v1/projects', {
    headers: { Authorization: `Token ${KEY}` },
  })
  line(`GET /v1/projects -> ${res.status}`)
  if (res.ok) {
    const body = await res.json()
    const project = body.projects?.[0]
    projectId = project?.project_id ?? null
    // Names can be personal; only the shape matters here.
    line(`projects returned: ${body.projects?.length ?? 0}`)
    line(`project_id present: ${Boolean(projectId)}`)
  } else {
    line(`body: ${safe(await res.text())}`)
  }
} catch (err) {
  line(`FAILED: ${err.message}`)
}

// ── 2. Ephemeral tokens ──────────────────────────────────────────────────────
// A browser cannot be given the real API key, so the server must mint a
// short-lived credential. Whether this endpoint exists decides the entire auth
// design, so it is worth knowing before a line of integration is written.
section('2. Ephemeral token grant (decides browser auth design)')
for (const path of [
  '/v1/auth/grant',
  projectId ? `/v1/projects/${projectId}/auth/grant` : null,
].filter(Boolean)) {
  try {
    const res = await fetch(`https://api.deepgram.com${path}`, {
      method: 'POST',
      headers: { Authorization: `Token ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: 30 }),
    })
    const text = await res.text()
    line(`POST ${path} -> ${res.status}`)
    // Report which FIELDS came back, never their values.
    try {
      line(`  keys: ${Object.keys(JSON.parse(text)).join(', ')}`)
    } catch {
      line(`  body: ${safe(text, 200)}`)
    }
  } catch (err) {
    line(`POST ${path} FAILED: ${err.message}`)
  }
}

// ── 3. Voice Agent websocket ─────────────────────────────────────────────────
section('3. Voice Agent socket')

if (typeof WebSocket === 'undefined') {
  line('This Node has no global WebSocket. Use Node 22+, or: npm i -D ws')
  process.exit(0)
}

const ENDPOINTS = ['wss://agent.deepgram.com/v1/agent/converse', 'wss://agent.deepgram.com/agent']

/** Candidate Settings payloads, newest documented shape first. */
const SETTINGS = [
  {
    label: 'v1 Settings (provider objects)',
    payload: {
      type: 'Settings',
      audio: {
        input: { encoding: 'linear16', sample_rate: 24000 },
        output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
      },
      agent: {
        language: 'en',
        listen: { provider: { type: 'deepgram', model: 'nova-3' } },
        think: {
          provider: { type: 'open_ai', model: 'gpt-4o-mini' },
          prompt: 'You are a test probe. Reply with one word.',
        },
        speak: { provider: { type: 'deepgram', model: 'aura-2-thalia-en' } },
      },
    },
  },
  {
    label: 'legacy SettingsConfiguration',
    payload: {
      type: 'SettingsConfiguration',
      audio: {
        input: { encoding: 'linear16', sample_rate: 24000 },
        output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
      },
      agent: {
        listen: { model: 'nova-2' },
        think: { provider: { type: 'open_ai' }, model: 'gpt-4o-mini', instructions: 'Test.' },
        speak: { model: 'aura-asteria-en' },
      },
    },
  },
]

/**
 * Did the server actually accept us?
 *
 * Only a greeting counts. An earlier version treated "any events at all" as
 * success on the timeout path, and duly reported ACCEPTED for a socket that had
 * done nothing but fail to connect twice — a probe that lies is worse than no
 * probe, since the whole point is to stop the integration being written against
 * assumptions.
 */
const accepted = (events) => events.some((e) => /Welcome|SettingsApplied/i.test(e))

/** Opens a socket, sends one Settings variant, records what comes back. */
function probe(url, variant) {
  return new Promise((resolve) => {
    const events = []
    let socket
    try {
      // Browsers cannot set headers on a WebSocket, so Deepgram carries the
      // credential in the subprotocol. Confirming this works is what makes a
      // browser client possible at all.
      socket = new WebSocket(url, ['token', KEY])
    } catch (err) {
      resolve({ ok: false, events: [`construct failed: ${err.message}`] })
      return
    }

    const done = (ok) => {
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      resolve({ ok, events })
    }

    const timer = setTimeout(() => done(accepted(events)), 9000)

    socket.onopen = () => {
      events.push('open')
      socket.send(JSON.stringify(variant.payload))
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        events.push(`binary frame (${event.data.byteLength ?? '?'} bytes) — audio out works`)
        return
      }
      try {
        const msg = JSON.parse(event.data)
        events.push(`${msg.type ?? 'untyped'}: ${safe(msg.description ?? msg.message ?? '', 220)}`)
      } catch {
        events.push(`text: ${safe(event.data, 220)}`)
      }
    }
    socket.onerror = () => events.push('socket error')
    socket.onclose = (event) => {
      events.push(`close ${event.code}${event.reason ? ` — ${safe(event.reason, 160)}` : ''}`)
      clearTimeout(timer)
      done(accepted(events))
    }
  })
}

for (const url of ENDPOINTS) {
  for (const variant of SETTINGS) {
    line()
    line(`→ ${url}`)
    line(`  variant: ${variant.label}`)
    const { ok, events } = await probe(url, variant)
    for (const e of events) line(`    ${e}`)
    if (ok) {
      line('    ✓ ACCEPTED — this is the working combination')
      // Stop at the first success: the rest is noise once we know the answer.
      section('Done — paste everything above back')
      process.exit(0)
    }
  }
}

section('Done — paste everything above back')
line('No combination was accepted. The close reasons above name the wrong field,')
line('which is the information needed to correct the schema.')
