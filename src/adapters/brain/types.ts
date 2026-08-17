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

export type Role = 'user' | 'assistant' | 'system'

export interface Message {
  role: Role
  content: string
  /** Wall-clock ms. */
  at: number
}

/** Streaming chunks. The UI assembles holographic text from these. */
export type BrainEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool-call'; id: string; name: string; args: Record<string, unknown> }
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

export interface Brain {
  readonly id: string
  readonly model: string
  /**
   * Streams a response. Async iteration rather than callbacks so that
   * backpressure and cancellation work naturally — the UI can stop consuming
   * and the underlying request aborts.
   */
  stream(request: BrainRequest): AsyncIterable<BrainEvent>
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
