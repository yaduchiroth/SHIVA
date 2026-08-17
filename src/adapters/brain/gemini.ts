import type { Brain, BrainEvent, BrainRequest, Message, ToolDefinition } from './types'

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

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args: Record<string, unknown> }
}

interface GeminiChunk {
  candidates?: {
    content?: { parts?: GeminiPart[] }
    finishReason?: string
  }[]
  promptFeedback?: { blockReason?: string }
  error?: { message?: string }
}

/** Our message shape → Gemini's `contents`. */
function toContents(messages: Message[]) {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))
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

export class GeminiBrain implements Brain {
  readonly id = 'gemini'

  constructor(
    readonly model: string = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    private readonly apiKey: string | undefined = process.env.GEMINI_API_KEY,
  ) {}

  /** Whether this brain can run at all, for capability checks in the UI. */
  get configured(): boolean {
    return Boolean(this.apiKey)
  }

  async *stream(request: BrainRequest): AsyncIterable<BrainEvent> {
    if (!this.apiKey) {
      yield {
        type: 'error',
        message: 'GEMINI_API_KEY is not set. Add it to .env.local and restart.',
      }
      return
    }

    const url = `${ENDPOINT}/${this.model}:streamGenerateContent?alt=sse`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        signal: request.signal,
        body: JSON.stringify({
          contents: toContents(request.messages),
          ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
          ...(toTools(request.tools) ? { tools: toTools(request.tools) } : {}),
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1024,
          },
        }),
      })
    } catch (err) {
      // An aborted request is the user interrupting, not a failure worth
      // reporting as one.
      if (request.signal?.aborted) return
      yield { type: 'error', message: `Network error: ${(err as Error).message}` }
      return
    }

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      yield {
        type: 'error',
        message: `Gemini returned ${response.status}. ${detail.slice(0, 200)}`,
      }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawText = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // SSE frames are separated by a blank line. Anything after the last
        // separator is a partial frame and must stay buffered — splitting on
        // newlines alone truncates JSON mid-object.
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''

        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'))
          if (!line) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue

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

          // A safety block yields no candidates at all — without this the
          // stream just ends and the UI shows nothing, with no explanation.
          if (chunk.promptFeedback?.blockReason) {
            yield {
              type: 'error',
              message: `Response blocked: ${chunk.promptFeedback.blockReason}`,
            }
            return
          }

          for (const candidate of chunk.candidates ?? []) {
            for (const part of candidate.content?.parts ?? []) {
              if (part.text) {
                sawText = true
                yield { type: 'text', delta: part.text }
              }
              if (part.functionCall) {
                yield {
                  type: 'tool-call',
                  // Gemini doesn't issue call ids; the name is unique per turn
                  // in practice and is what the dispatcher keys on anyway.
                  id: part.functionCall.name,
                  name: part.functionCall.name,
                  args: part.functionCall.args ?? {},
                }
              }
            }

            if (candidate.finishReason && candidate.finishReason !== 'STOP') {
              yield {
                type: 'error',
                message: `Generation stopped: ${candidate.finishReason}`,
              }
              return
            }
          }
        }
      }
    } catch (err) {
      if (request.signal?.aborted) return
      yield { type: 'error', message: `Stream failed: ${(err as Error).message}` }
      return
    } finally {
      reader.releaseLock()
    }

    if (!sawText) {
      // Distinguishes "the model said nothing" from "we never got that far",
      // which otherwise look identical to the user.
      yield { type: 'error', message: 'The model returned an empty response.' }
      return
    }

    yield { type: 'done', reason: 'stop' }
  }
}
