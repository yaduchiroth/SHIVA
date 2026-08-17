import type { Brain, BrainEvent, BrainRequest, BrainStatus, Message, ToolDefinition } from './types'
import { SseFramer, sseData } from '@/lib/sse'

/**
 * Gemini brain.
 *
 * Runs server-side only — `GEMINI_API_KEY` must never reach the browser, which
 * is why it has no `NEXT_PUBLIC_` prefix and this module is imported solely by
 * `app/api/brain/route.ts`.
 *
 * The API's sharp edges, each of which produces a silent failure rather than an
 * error:
 *   - `alt=sse` is required. Without it the endpoint returns a JSON array that
 *     only completes at the end, which defeats streaming entirely.
 *   - Roles are `user` / `model`, not `assistant`.
 *   - The system prompt is a separate `systemInstruction` field, not a message.
 *   - A blocked response streams no text and otherwise looks like a normal
 *     empty success, so `promptFeedback.blockReason` has to be checked
 *     explicitly or the UI just sits there.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

/**
 * Statuses worth retrying.
 *
 * 503 means "this model is experiencing high demand" and 429 is a rate limit —
 * both are explicitly temporary, and both are common enough on a shared free
 * tier that surfacing them as failures makes the assistant feel broken at
 * random. Everything else (401 bad key, 400 malformed, 404 retired model) is a
 * fault that retrying only delays.
 */
const RETRYABLE = new Set([429, 503, 500, 502, 504])
const MAX_ATTEMPTS = 2
/** Base for exponential backoff, in ms. */
const BACKOFF_MS = 600

/**
 * Models to fall through to when the preferred one is unavailable.
 *
 * This is not redundancy for its own sake. On a free-tier key the flagship
 * flash models are routinely rate-limited (429) or saturated (503) while the
 * lite models answer immediately — verified, both statuses observed minutes
 * apart on the same key. Retrying one model harder does not help; it is out of
 * quota, not momentarily busy.
 *
 * Falling through keeps the assistant answering with a slightly smaller model
 * instead of failing outright, which is the difference between "occasionally
 * less sharp" and "randomly broken".
 */
const FALLBACK_MODELS = ['gemini-flash-lite-latest', 'gemini-3-flash-preview']

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args: Record<string, unknown>; id?: string }
  thoughtSignature?: string
}

interface GeminiChunk {
  candidates?: {
    content?: { parts?: GeminiPart[] }
    finishReason?: string
  }[]
  promptFeedback?: { blockReason?: string }
  error?: { message?: string }
}

/**
 * Our message shape → Gemini's `contents`.
 *
 * Tool results are the awkward part. Gemini models them as a `functionResponse`
 * part on a *user* turn, which must be preceded by the `functionCall` part on
 * the model turn that requested it. Reconstructing that pair is what lets the
 * model answer FROM tool output rather than merely triggering a tool and then
 * having nothing to say.
 */
function toContents(messages: Message[]) {
  const contents: {
    role: string
    parts: Record<string, unknown>[]
  }[] = []

  for (const m of messages) {
    if (m.role === 'system') continue

    if (m.role === 'tool') {
      // Replay the call, then the result. The thought signature rides on the
      // call part; Gemini 3 rejects the exchange without it.
      contents.push({
        role: 'model',
        parts: [
          {
            functionCall: { name: m.toolName ?? 'unknown', args: {} },
            ...(m.thoughtSignature ? { thoughtSignature: m.thoughtSignature } : {}),
          },
        ],
      })
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.toolName ?? 'unknown',
              response: { result: m.content },
            },
          },
        ],
      })
      continue
    }

    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })
  }

  return contents
}

/** Our tool shape → Gemini's `functionDeclarations`. */
function toTools(tools: ToolDefinition[] | undefined) {
  if (!tools?.length) return undefined
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ]
}

/**
 * Parses SSE frames into brain events.
 *
 * Shared by the streaming loop and the end-of-stream drain, so a frame is
 * interpreted identically whether it arrived with a trailing blank line or as
 * the tail of the final chunk. Keeping one implementation is the point: the two
 * paths diverging is exactly how the drain came to be missing in the first
 * place.
 */
function* parseFrames(frames: string[]): Generator<BrainEvent> {
  for (const frame of frames) {
    const payload = sseData(frame)
    if (!payload) continue

    let chunk: GeminiChunk
    try {
      chunk = JSON.parse(payload) as GeminiChunk
    } catch {
      continue
    }

    if (chunk.error?.message) {
      yield { type: 'error', message: chunk.error.message }
      return
    }

    // A safety block yields no candidates at all — without this the stream just
    // ends and the UI shows nothing, with no explanation.
    if (chunk.promptFeedback?.blockReason) {
      yield { type: 'error', message: `Response blocked: ${chunk.promptFeedback.blockReason}` }
      return
    }

    for (const candidate of chunk.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.text) yield { type: 'text', delta: part.text }
        if (part.functionCall) {
          yield {
            type: 'tool-call',
            // Newer models issue a real call id; older ones don't, and the name
            // is unique per turn in practice.
            id: part.functionCall.id ?? part.functionCall.name,
            name: part.functionCall.name,
            args: part.functionCall.args ?? {},
            thoughtSignature: part.thoughtSignature,
          }
        }
      }

      // MAX_TOKENS after real content is a truncation, not a failure — the
      // caller already has usable text and an error would discard it.
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        yield { type: 'error', message: `Generation stopped: ${candidate.finishReason}` }
        return
      }
    }
  }
}

/**
 * Pulls the human-readable sentence out of a Google error body.
 *
 * This replaced `body.slice(0, 180)`, which was worse than it looks. Google
 * wraps its message in ~40 characters of JSON envelope, and puts the sentence
 * naming the fix — "Enable it by visiting https://..." — at the END. So
 * truncating at a fixed length reliably delivered the part that identifies the
 * error and discarded the part that resolves it.
 */
function extractGoogleMessage(body: string): string {
  if (!body) return '(no detail)'
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } }
    const message = parsed.error?.message
    if (message) {
      const status = parsed.error?.status
      // The symbolic status (PERMISSION_DENIED, INVALID_ARGUMENT) is the part
      // that is actually searchable, so keep it alongside the prose.
      return status ? `${message} [${status}]` : message
    }
  } catch {
    /* not JSON — fall through to the raw body */
  }
  return body.slice(0, 400)
}

/**
 * Narrows a model listing to things worth suggesting.
 *
 * The raw list runs to fifty entries and includes embeddings, video, speech,
 * robotics and image models — none of which can serve a chat turn. Returning it
 * whole would put a kilobyte of noise in a probe response and offer the user a
 * "suggestion" they have to filter themselves.
 */
function suggestable(available: string[]): string[] {
  const EXCLUDE = /image|tts|audio|embedding|live|veo|lyria|robotics|computer-use|aqa|gemma/
  return available.filter((name) => /^gemini-/.test(name) && !EXCLUDE.test(name)).slice(0, 6)
}

/** Same extraction, for a Response whose body has not been read yet. */
async function readGoogleError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  return `${extractGoogleMessage(body)} (HTTP ${response.status})`
}

export class GeminiBrain implements Brain {
  readonly id = 'gemini'

  constructor(
    // `gemini-flash-latest` is an alias that tracks the current flash model.
    // Pinning an explicit version is how this broke once already: the pinned
    // `gemini-2.5-flash` was retired for new keys and every request returned a
    // 404 that read like a bad key rather than a stale model name.
    readonly model: string = process.env.GEMINI_MODEL ?? 'gemini-flash-latest',
    private readonly apiKey: string | undefined = process.env.GEMINI_API_KEY,
  ) {}

  /**
   * Whether a key is present. NOT whether it works.
   *
   * Kept because the streaming path genuinely needs the cheap check, but it is
   * no longer reported to the UI as readiness — that was the bug. See
   * `verify()`, and `BrainStatus` for why a boolean was never enough.
   */
  get configured(): boolean {
    return Boolean(this.apiKey)
  }

  /**
   * Asks Google whether this key and model actually work.
   *
   * Listing models is the right probe: free, read-only, spends no quota, and it
   * separates the three failures a boolean conflated. It costs one round trip
   * on page load, which is why the route caches it.
   */
  async verify(): Promise<BrainStatus> {
    if (!this.apiKey) return { status: 'no-key' }

    let response: Response
    try {
      response = await fetch(ENDPOINT, {
        headers: { 'x-goog-api-key': this.apiKey },
        signal: AbortSignal.timeout(8000),
      })
    } catch (err) {
      // Unreachable is NOT a bad key. Reporting it as one sends someone off to
      // rotate a credential that was never the problem.
      return { status: 'unreachable', detail: (err as Error).message }
    }

    if (!response.ok) {
      return { status: 'rejected', detail: await readGoogleError(response) }
    }

    const body = (await response.json().catch(() => null)) as {
      models?: { name?: string }[]
    } | null

    const available = (body?.models ?? [])
      .map((m) => String(m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean)

    if (!available.includes(this.model)) {
      // The failure that already happened once: a pinned model was retired and
      // every request 404'd in a way that read like a bad key.
      return { status: 'model-missing', model: this.model, available: suggestable(available) }
    }

    return { status: 'ready', model: this.model }
  }

  async *stream(request: BrainRequest): AsyncIterable<BrainEvent> {
    if (!this.apiKey) {
      yield {
        type: 'error',
        message: 'GEMINI_API_KEY is not set. Add it to .env.local and restart.',
      }
      return
    }

    const body = JSON.stringify({
      contents: toContents(request.messages),
      ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
      ...(toTools(request.tools) ? { tools: toTools(request.tools) } : {}),
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
      },
    })

    let response: Response | null = null
    let lastStatus = 0
    let lastDetail = ''

    // Deduped so an explicit GEMINI_MODEL matching a fallback isn't tried twice.
    const candidates = [this.model, ...FALLBACK_MODELS].filter((m, i, all) => all.indexOf(m) === i)

    outer: for (const candidate of candidates) {
      const url = `${ENDPOINT}/${candidate}:streamGenerateContent?alt=sse`

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (request.signal?.aborted) return

        try {
          response = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-goog-api-key': this.apiKey,
            },
            signal: request.signal,
            body,
          })
        } catch (err) {
          // An aborted request is the user interrupting, not a failure worth
          // reporting as one.
          if (request.signal?.aborted) return
          yield { type: 'error', message: `Network error: ${(err as Error).message}` }
          return
        }

        if (response.ok && response.body) break outer

        lastStatus = response.status
        lastDetail = await response.text().catch(() => '')
        response = null

        // A non-retryable status is a fault this model will keep returning —
        // but a RETIRED model (404) is worth trying the next candidate for.
        if (!RETRYABLE.has(lastStatus)) break

        if (attempt < MAX_ATTEMPTS - 1) {
          // Backoff. Retrying a saturated endpoint immediately just rejoins the
          // queue that rejected the first attempt.
          await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * 2 ** attempt))
        }
      }

      // Out of quota or saturated on this model — try the next one rather than
      // hammering the one that just refused.
      if (!RETRYABLE.has(lastStatus) && lastStatus !== 404) break
    }

    if (!response?.body) {
      const overloaded = lastStatus === 503 || lastStatus === 429
      yield {
        type: 'error',
        message: overloaded
          ? // Say what it is rather than leaking a raw status: this is not the
            // user's fault and not fixable by them. Every fallback was tried.
            'Every Gemini model is rate-limited or busy right now. This is a quota' +
            ' limit on the key, not a fault — try again shortly.'
          : `Gemini returned ${lastStatus}. ${extractGoogleMessage(lastDetail)}`,
      }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const framer = new SseFramer()
    // Tracked separately: a command like "open markets" returns a functionCall
    // and NO text at all — the model acts instead of narrating. Treating that
    // as an empty response would turn every successful interface command into
    // an error, which is precisely what it did before this was split out.
    let sawText = false
    let sawToolCall = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        const frames = done ? framer.flush() : framer.push(decoder.decode(value, { stream: true }))

        for (const event of parseFrames(frames)) {
          if (event.type === 'text') sawText = true
          if (event.type === 'tool-call') sawToolCall = true
          yield event
          if (event.type === 'error') return
        }

        if (done) break
      }
    } catch (err) {
      if (request.signal?.aborted) return
      yield { type: 'error', message: `Stream failed: ${(err as Error).message}` }
      return
    } finally {
      reader.releaseLock()
    }

    if (!sawText && !sawToolCall) {
      // Genuinely nothing came back — distinct from a silent tool call, and
      // distinct from "we never got that far", which otherwise all look the
      // same to the user.
      yield { type: 'error', message: 'The model returned an empty response.' }
      return
    }

    yield { type: 'done', reason: 'stop' }
  }
}
