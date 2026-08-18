/**
 * Neural speech synthesis.
 *
 * The browser's built-in `speechSynthesis` is serviceable but unmistakably
 * synthetic — flat prosody, wrong emphasis, no sense of a sentence. For an
 * assistant you talk to, that is most of what makes it feel like a machine
 * rather than a conversation.
 *
 * Two providers, tried in order, both returning raw 24 kHz mono PCM base64
 * (`audio/L16`) because that is what the client already knows how to play. It
 * is deliberately not transcoded here: PCM is what both models emit, and
 * re-encoding on an edge function would cost more than it saves.
 *
 *   1. **Deepgram Aura**, when `DEEPGRAM_API_KEY` is set. The best of the
 *      three by a clear margin, and the reason it is first.
 *   2. **Gemini TTS**, using the key the brain already needs.
 *   3. The browser, in `src/brain/speech.ts`, if both fail.
 *
 * The client is told which one answered but does not choose. Vendor selection
 * belongs where the credentials are, and a client that named a provider would
 * have to be redeployed to change one.
 *
 * The trade against the browser is latency: nothing is spoken until the whole
 * utterance is generated, whereas the browser starts immediately. That is why
 * this is a *fallback-capable* path rather than the only one.
 */

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
const DEEPGRAM_ENDPOINT = 'https://api.deepgram.com/v1/speak'

/** Longest utterance worth synthesising. Beyond this, latency defeats the point. */
const MAX_CHARS = 600

/** Both providers are asked for this, so the client never has to resample. */
const SAMPLE_RATE = 24000

interface Spoken {
  /** Base64 signed 16-bit little-endian PCM, mono. */
  audio: string
  sampleRate: number
  provider: 'deepgram' | 'gemini'
}

interface Failed {
  error: string
  detail: string
  status: number
}

const failed = (error: string, detail: string, status = 502): Failed => ({
  error,
  detail: detail.slice(0, 300),
  status,
})

/**
 * Deepgram Aura.
 *
 * **Not verified against the live service.** The build environment this was
 * written in is denied egress to `api.deepgram.com`, so what follows is written
 * from the documented contract and has never had a byte come back. The parts
 * most likely to be wrong, in order:
 *
 *   1. `model` — Aura-2 voices are named `aura-2-<name>-en`. If the account is
 *      on Aura-1 the prefix is `aura-<name>-en` and this returns 400. Set
 *      `DEEPGRAM_TTS_MODEL` rather than editing here.
 *   2. `encoding=linear16` should return headerless PCM. If it arrives with a
 *      44-byte WAV header instead, the first 22 samples are a burst of noise —
 *      audible, and the giveaway.
 *   3. `sample_rate` is only honoured for the raw encodings.
 *
 * Every failure returns Deepgram's own body rather than a summary of it, for
 * the same reason `scripts/doctor.mjs` prints Google's: the sentence naming the
 * fix is in there, and paraphrasing loses it.
 */
async function speakDeepgram(
  apiKey: string,
  text: string,
  voice?: string,
): Promise<Spoken | Failed> {
  const model = voice ?? process.env.DEEPGRAM_TTS_MODEL ?? 'aura-2-thalia-en'
  const url = `${DEEPGRAM_ENDPOINT}?model=${encodeURIComponent(model)}&encoding=linear16&sample_rate=${SAMPLE_RATE}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Token ${apiKey}` },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ text }),
  })

  if (!res.ok) {
    return failed(`Deepgram returned ${res.status}`, await res.text().catch(() => ''))
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length === 0) return failed('Deepgram returned no audio', '')

  return { audio: toBase64(bytes), sampleRate: SAMPLE_RATE, provider: 'deepgram' }
}

/** Gemini TTS. Verified working. */
async function speakGemini(apiKey: string, text: string, voice?: string): Promise<Spoken | Failed> {
  const model = process.env.GEMINI_TTS_MODEL ?? 'gemini-2.5-flash-preview-tts'
  // Kore reads as calm and level, which suits an assistant that mostly reports
  // state. Override with GEMINI_TTS_VOICE — Puck and Charon are warmer.
  const voiceName = voice ?? process.env.GEMINI_TTS_VOICE ?? 'Kore'

  const res = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      },
    }),
  })

  if (!res.ok) {
    return failed(`Gemini TTS returned ${res.status}`, await res.text().catch(() => ''))
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[]
  }
  const inline = data.candidates?.[0]?.content?.parts?.[0]?.inlineData
  if (!inline?.data)
    return failed('Gemini TTS returned no audio', JSON.stringify(data).slice(0, 300))

  // Sample rate travels in the mime type (`audio/L16;codec=pcm;rate=24000`).
  // Parsing it rather than assuming means a model that changes rate does not
  // silently play back at the wrong pitch.
  const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1] ?? SAMPLE_RATE)
  return { audio: inline.data, sampleRate: rate, provider: 'gemini' }
}

/**
 * Bytes to base64 without `Buffer`, which the edge runtime does not have.
 *
 * Chunked because `String.fromCharCode(...bytes)` spreads every byte as an
 * argument, and a few seconds of 24 kHz PCM is well past the argument limit —
 * where it does not return a wrong answer, it throws.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

const isFailure = (result: Spoken | Failed): result is Failed => 'error' in result

export async function POST(request: Request) {
  const deepgramKey = process.env.DEEPGRAM_API_KEY?.trim()
  const geminiKey = process.env.GEMINI_API_KEY?.trim()

  if (!deepgramKey && !geminiKey) {
    return Response.json(
      { error: 'No TTS credential. Set DEEPGRAM_API_KEY or GEMINI_API_KEY.' },
      { status: 501 },
    )
  }

  let body: { text?: string; voice?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const text = (body.text ?? '').trim().slice(0, MAX_CHARS)
  if (!text) return Response.json({ error: 'text is required' }, { status: 400 })

  // Deepgram first, Gemini as the fallback. The fall-through is deliberate and
  // not just for a missing key: an unverified integration that 400s on every
  // request would otherwise take speech down with it, when a working second
  // provider is right there.
  const attempts: Failed[] = []

  if (deepgramKey) {
    try {
      const result = await speakDeepgram(deepgramKey, text, body.voice)
      if (!isFailure(result)) return Response.json(result)
      attempts.push(result)
    } catch (err) {
      attempts.push(failed('Deepgram unreachable', (err as Error).message))
    }
  }

  if (geminiKey) {
    try {
      const result = await speakGemini(geminiKey, text, deepgramKey ? undefined : body.voice)
      if (!isFailure(result)) {
        // Said out loud, because a Deepgram key that silently never works looks
        // exactly like one that does — the reply is spoken either way.
        return Response.json(attempts.length ? { ...result, fellBackFrom: attempts[0] } : result, {
          status: 200,
        })
      }
      attempts.push(result)
    } catch (err) {
      attempts.push(failed('Gemini unreachable', (err as Error).message))
    }
  }

  const first = attempts[0] ?? failed('No provider ran', '')
  return Response.json({ error: first.error, detail: first.detail, attempts }, { status: 502 })
}
