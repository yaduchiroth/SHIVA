/**
 * The AI brain contract — Phase 2.
 *
 * Defined now, implemented later, for one specific reason: the shape of this
 * interface determines whether Phase 2 slots into the spatial layer or requires
 * rewriting it. Committing to the contract while the renderer is still being
 * built is what keeps that from happening.
 *
 * Gemini is the chosen provider (`GEMINI_API_KEY`, `GEMINI_MODEL`), but nothing
 * in this file names it. Keeping the seam provider-neutral costs nothing today
 * and means a provider swap is one new file rather than a refactor.
 *
 * Non-negotiable: implementations run SERVER-side only. The API key must never
 * reach the browser — hence `app/api/brain/`, not a client-side SDK call.
 */

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface Message {
  role: Role
  content: string
  /** Wall-clock ms. */
  at: number
  /**
   * Set on `tool` messages: which function produced this result, and — for
   * models that emit one — the opaque reasoning token that must be echoed back
   * with the call. Gemini 3 rejects a function-response turn that drops it.
   */
  toolName?: string
  toolCallId?: string
  thoughtSignature?: string
}

/** Streaming chunks. The UI assembles holographic text from these. */
export type BrainEvent =
  | { type: 'text'; delta: string }
  | {
      type: 'tool-call'
      id: string
      name: string
      args: Record<string, unknown>
      /** Opaque reasoning token; must be returned with the result if present. */
      thoughtSignature?: string
    }
  | { type: 'tool-result'; id: string; result: unknown }
  | { type: 'done'; reason: 'stop' | 'length' | 'tool' }
  | { type: 'error'; message: string }

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>
}

export interface BrainRequest {
  messages: Message[]
  tools?: ToolDefinition[]
  /** Personality and operating instructions. */
  system?: string
  signal?: AbortSignal
}

/**
 * What a readiness probe is allowed to claim.
 *
 * A boolean was the bug. `configured` meant "a non-empty string exists in an
 * environment variable" and was reported to the UI as readiness, so three
 * unrelated failures — the env file never loading, a credential the provider
 * rejects, and a model that no longer exists — all surfaced as the same
 * sentence, and only one of them was even about a missing key.
 *
 * This is the same union `DataResult` already uses for panel data (see
 * adapters/data/types.ts), applied to the one place it was skipped: a source is
 * live, unconfigured, or failed, and the UI is forced to tell them apart.
 */
export type BrainStatus =
  /** Ready. The credential works and the configured model exists. */
  | { status: 'ready'; model: string }
  /** No credential reached the server at all. */
  | { status: 'no-key' }
  /** The provider refused the credential. `detail` is the provider's own words. */
  | { status: 'rejected'; detail: string }
  /** The credential works, but the configured model is not available to it. */
  | { status: 'model-missing'; model: string; available: string[] }
  /** The provider could not be reached — network, proxy or timeout. */
  | { status: 'unreachable'; detail: string }

export interface Brain {
  readonly id: string
  readonly model: string
  /**
   * Streams a response. Async iteration rather than callbacks so that
   * backpressure and cancellation work naturally — the UI can stop consuming
   * and the underlying request aborts.
   */
  stream(request: BrainRequest): AsyncIterable<BrainEvent>
  /**
   * Asks the provider whether this brain can actually run.
   *
   * Separate from `stream` because the UI needs to know BEFORE the user speaks,
   * and separate from a plain boolean because "it can't" has several different
   * answers with different fixes.
   */
  verify(): Promise<BrainStatus>
}

/**
 * Phase 5: sub-agents.
 *
 * The design doc calls for SHIVA spawning specialist agents on demand — a
 * vision agent for the live camera, a research agent, a coding agent. They're
 * represented as tools from the main brain's perspective, which means the
 * orchestration is just tool-calling and needs no separate protocol.
 */
export interface SubAgentSpec {
  id: string
  purpose: string
  /** Tools this sub-agent may use — deliberately narrower than the parent's. */
  tools: ToolDefinition[]
  /** Bounds runaway delegation loops. */
  maxSteps: number
}
