import { expect, test } from '@playwright/test'
import { SAMPLE_RATE, buildSettings, describeClose } from '@/adapters/voice/deepgram'
import { TOOLS } from '@/adapters/brain/commands'

/**
 * Voice agent handshake.
 *
 * These cannot tell you the schema is *right* — only the live service can, and
 * the build container is denied egress to it. What they do is hold the
 * invariants that are true regardless of which schema revision turns out to be
 * correct: the two sample rates agree, the tools are the same ones the typed
 * brain uses, and a close code always produces something a person can act on.
 *
 * That is the useful half. A wrong endpoint fails loudly on first connect; a
 * sample-rate mismatch or a diverged tool list fails silently, forever.
 */

test.describe('buildSettings', () => {
  test('input and output rates agree with SAMPLE_RATE', () => {
    const settings = buildSettings('be brief', [])
    // A mismatch here does not error. The agent hears speech at the wrong speed
    // and transcribes nonsense, which reads as "the model is bad".
    expect(settings.audio.input.sample_rate).toBe(SAMPLE_RATE)
    expect(settings.audio.output.sample_rate).toBe(SAMPLE_RATE)
  })

  test('declares raw linear16 in both directions', () => {
    const settings = buildSettings('be brief', [])
    expect(settings.audio.input.encoding).toBe('linear16')
    expect(settings.audio.output.encoding).toBe('linear16')
    // A container would mean parsing a header before playback rather than
    // treating each frame as samples.
    expect(settings.audio.output.container).toBe('none')
  })

  test('omits functions entirely rather than sending an empty array', () => {
    const settings = buildSettings('be brief', [])
    expect('functions' in settings.agent.think).toBe(false)
  })

  test('carries the prompt through unchanged', () => {
    const prompt = 'You are SHIVA.\nDo not invent numbers.'
    expect(buildSettings(prompt, []).agent.think.prompt).toBe(prompt)
  })

  test('sends the same tools the typed brain uses', () => {
    // The point of sharing them: a spoken question and a typed one read the
    // same live panels. Two lists would drift and the same question would get
    // two different answers depending on how it was asked.
    const settings = buildSettings('be brief', TOOLS)
    expect(settings.agent.think.functions).toHaveLength(TOOLS.length)
    expect(settings.agent.think.functions?.map((f) => f.name)).toContain('read_module')
  })

  test('every tool carries a JSON Schema the service can validate', () => {
    for (const tool of buildSettings('x', TOOLS).agent.think.functions ?? []) {
      expect(tool.name).toBeTruthy()
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.parameters).toHaveProperty('type', 'object')
    }
  })
})

test.describe('describeClose', () => {
  test('prefers the server reason over the code', () => {
    // The reason string names the offending field. It is the single most useful
    // thing the service returns, and logging only the code discards it.
    expect(describeClose(1008, 'invalid field: agent.speak.provider.model')).toContain(
      'agent.speak.provider.model',
    )
  })

  test('explains an abnormal close, which carries no reason by definition', () => {
    const message = describeClose(1006, '')
    expect(message).toContain('agent.deepgram.com')
  })

  test('names the credential for auth-shaped codes', () => {
    expect(describeClose(4001, '')).toContain('DEEPGRAM_API_KEY')
  })

  test('always returns something actionable, even for an unknown code', () => {
    expect(describeClose(4999, '')).toContain('4999')
  })

  test('ignores a whitespace-only reason', () => {
    expect(describeClose(1011, '   ')).toContain('server error')
  })
})

/**
 * Which voice speaks.
 *
 * The failure this guards against is specific and silent: a Deepgram key that
 * is wrong, expired, or names a model the account cannot use produces a reply
 * that is still spoken — by Gemini — and sounds perfectly fine. Someone would
 * reasonably conclude the good voice was working. So the route reports which
 * provider answered, and falling back is recorded rather than swallowed.
 */
test.describe('the speech route', () => {
  test('says which provider spoke, or why none could', async ({ request }) => {
    const res = await request.post('/api/speech', { data: { text: 'systems nominal' } })

    if (res.status() === 501) {
      // No credential at all, which is the case in CI. The message has to name
      // the variables, because "TTS unavailable" sends nobody anywhere.
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/DEEPGRAM_API_KEY/)
      expect(body.error).toMatch(/GEMINI_API_KEY/)
      return
    }

    if (res.ok()) {
      const body = (await res.json()) as { provider: string; audio: string; sampleRate: number }
      expect(['deepgram', 'gemini']).toContain(body.provider)
      expect(body.audio.length).toBeGreaterThan(0)
      expect(body.sampleRate).toBeGreaterThan(8000)
      return
    }

    // Both providers were tried and both refused. Every attempt is reported,
    // with the vendor's own words — the sentence naming the fix is in there,
    // and a summary loses it.
    const body = (await res.json()) as { attempts?: { error: string; detail: string }[] }
    expect(body.attempts?.length ?? 0).toBeGreaterThan(0)
  })

  test('an empty utterance is refused rather than synthesised', async ({ request }) => {
    const res = await request.post('/api/speech', { data: { text: '   ' } })
    expect([400, 501]).toContain(res.status())
  })
})
