/**
 * Neural speech synthesis.
 *
 * The browser's built-in `speechSynthesis` is serviceable but unmistakably
 * synthetic — flat prosody, wrong emphasis, no sense of a sentence. For an
 * assistant you talk to, that is most of what makes it feel like a machine
 * rather than a conversation.
 *
 * Gemini's TTS models return real neural audio. The trade is latency: nothing
 * is spoken until the whole utterance is generated, whereas the browser starts
 * immediately. That is why this is a *fallback-capable* path rather than the
 * only one — see `src/brain/speech.ts`.
 *
 * Returns 24 kHz mono PCM (`audio/L16`), which the client wraps in a WAV header
 * and plays. It is deliberately not transcoded here: PCM is what the model
 * emits, and re-encoding on an edge function would cost more than it saves.
 */

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

/** Longest utterance worth synthesising. Beyond this, latency defeats the point. */
const MAX_CHARS = 600

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return Response.json({ error: 'GEMINI_API_KEY is not set' }, { status: 501 })
  }

  let body: { text?: string; voice?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const text = (body.text ?? '').trim().slice(0, MAX_CHARS)
  if (!text) return Response.json({ error: 'text is required' }, { status: 400 })

  const model = process.env.GEMINI_TTS_MODEL ?? 'gemini-2.5-flash-preview-tts'
  // Kore reads as calm and level, which suits an assistant that mostly reports
  // state. Override with GEMINI_TTS_VOICE — Puck and Charon are warmer.
  const voice = body.voice ?? process.env.GEMINI_TTS_VOICE ?? 'Kore'

  try {
    const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // 4xx/5xx here is not fatal to the conversation — the client falls back to
      // browser speech, so this reports rather than throws.
      return Response.json(
        { error: `TTS returned ${res.status}`, detail: detail.slice(0, 200) },
        { status: 502 },
      )
    }

    const data = (await res.json()) as {
      candidates?: {
        content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] }
      }[]
    }
    const inline = data.candidates?.[0]?.content?.parts?.[0]?.inlineData
    if (!inline?.data) {
      return Response.json({ error: 'No audio in response' }, { status: 502 })
    }

    // Sample rate travels in the mime type (`audio/L16;codec=pcm;rate=24000`).
    // Parsing it rather than assuming means a model that changes rate doesn't
    // silently play back at the wrong pitch.
    const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1] ?? 24000)

    return Response.json({ audio: inline.data, sampleRate: rate })
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 })
  }
}
