import type { Brain, BrainEvent, BrainRequest } from './types'

/**
 * Gemini brain — Phase 2 stub.
 *
 * Intentionally not implemented. What's here is the wiring that Phase 2 fills
 * in, plus the environment contract, so that starting Phase 2 means writing the
 * request/response mapping and nothing else.
 *
 * When implementing, the notes below are the parts that are easy to get wrong:
 *
 *   - Endpoint: `v1beta/models/{model}:streamGenerateContent?alt=sse`. Without
 *     `alt=sse` the API returns a JSON array that only completes at the end,
 *     which defeats streaming entirely.
 *   - Gemini's role vocabulary is `user` / `model`, and the system prompt is a
 *     separate `systemInstruction` field rather than a message with a role.
 *   - Tool calls arrive as `functionCall` parts inside candidate content, and
 *     results are sent back as `functionResponse` parts on a `user` turn.
 *   - Every chunk must be checked for `promptFeedback.blockReason`; a blocked
 *     response streams no text and otherwise looks like an empty success.
 */
export class GeminiBrain implements Brain {
  readonly id = 'gemini'

  constructor(
    readonly model: string = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    private readonly apiKey: string | undefined = process.env.GEMINI_API_KEY,
  ) {}

  /** Whether this brain can actually run, for capability checks in the UI. */
  get configured(): boolean {
    return Boolean(this.apiKey)
  }

  async *stream(_request: BrainRequest): AsyncIterable<BrainEvent> {
    if (!this.configured) {
      yield {
        type: 'error',
        message: 'GEMINI_API_KEY is not set. Copy .env.example to .env.local and add a key.',
      }
      return
    }

    yield {
      type: 'error',
      message: 'The Gemini brain is not implemented yet — it lands in Phase 2.',
    }
  }
}
