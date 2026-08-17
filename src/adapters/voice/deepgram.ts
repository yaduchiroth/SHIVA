/**
 * Deepgram Voice Agent protocol.
 *
 * One socket replaces the three-step turn SHIVA had before — recognise, think,
 * synthesise — with a continuous conversation: microphone audio goes up, agent
 * audio comes down, and the agent decides when to speak. That difference is the
 * whole point. Turn-based voice always sounds like dictation followed by a
 * readout; this is what makes it sound like talking to something.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS VERIFIED, AND WHAT IS NOT
 *
 * Nothing in this file has been exercised against the live service. The build
 * container's egress policy denies `api.deepgram.com` and `agent.deepgram.com`
 * at the gateway (403 on CONNECT), so it is written from documentation rather
 * than from observed behaviour — which is exactly the situation that produced
 * three shipped bugs against Gemini: a retired model ID, a CRLF frame separator,
 * and a response shape carrying no text. None were visible to reasoning.
 *
 * So every value the service could disagree with is a named constant in THIS
 * FILE, and nothing downstream hard-codes one. `scripts/probe-deepgram.mjs`
 * prints what the service actually accepts; correcting this file against that
 * output is editing literals, not rewriting the client.
 *
 * The ones most likely to be wrong, in order:
 *   1. `ENDPOINT` — the path has changed at least once (`/agent` → `/v1/agent/converse`).
 *   2. `MODELS.speak` — voice names are versioned and get retired, exactly as
 *      `gemini-2.5-flash` did.
 *   3. The `Settings` shape — an older revision used `SettingsConfiguration`
 *      with flat model fields instead of `provider` objects.
 *   4. `GRANT_PATH` — whether ephemeral tokens are account- or project-scoped.
 *
 * A wrong guess here fails loudly: the socket closes with a reason string that
 * names the offending field. That is by design — see `describeClose`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { ToolDefinition } from '@/adapters/brain/types'

/** The agent websocket. Path has changed before; confirm with the probe. */
export const ENDPOINT = 'wss://agent.deepgram.com/v1/agent/converse'

/** Ephemeral-token grant, called server-side only. See app/api/voice/token. */
export const GRANT_PATH = 'https://api.deepgram.com/v1/auth/grant'

/**
 * Both directions run at 24 kHz.
 *
 * Not a free choice: it must match the `sample_rate` in the Settings payload
 * exactly, and a mismatch does not error — the agent simply hears everything at
 * the wrong speed and transcribes nonsense. Keeping input and output identical
 * also means the playback path needs no second resampler.
 */
export const SAMPLE_RATE = 24000

/**
 * How much audio each upstream frame carries, in samples at SAMPLE_RATE.
 *
 * 2048 ≈ 85 ms. Smaller frames cut the latency before the agent notices you
 * started talking; larger ones cut websocket overhead. This sits at the point
 * where barge-in still feels immediate.
 */
export const FRAME_SAMPLES = 2048

export const MODELS = {
  /** Speech recognition. */
  listen: 'nova-3',
  /** Voice. Deepgram's voice names are versioned and do get retired. */
  speak: 'aura-2-thalia-en',
  /**
   * The reasoning model, hosted by Deepgram.
   *
   * SHIVA's own brain is Gemini, and it stays that way for typed conversation —
   * this is a second, separate brain that exists only inside the voice socket.
   * Running the spoken side through Deepgram's hosted model rather than routing
   * back to `/api/brain` is a deliberate trade: their orchestration is what
   * makes interruption and turn-taking work, and a bring-your-own-LLM endpoint
   * must be reachable from Deepgram's servers — which `localhost:3000` is not.
   *
   * The cost is that voice and text can answer with slightly different wording.
   * They cannot disagree on FACTS, because both read the same live panels
   * through the same tools (see TOOLS below), which is the part that matters.
   */
  think: 'gpt-4o-mini',
  thinkProvider: 'open_ai',
} as const

/** Client → server. Binary frames carry microphone audio and have no type. */
export interface SettingsMessage {
  type: 'Settings'
  audio: {
    input: { encoding: 'linear16'; sample_rate: number }
    output: { encoding: 'linear16'; sample_rate: number; container: 'none' }
  }
  agent: {
    language: string
    listen: { provider: { type: 'deepgram'; model: string } }
    think: {
      provider: { type: string; model: string }
      prompt: string
      functions?: ToolDefinition[]
    }
    speak: { provider: { type: 'deepgram'; model: string } }
    greeting?: string
  }
}

export interface FunctionCall {
  id: string
  name: string
  /** JSON, as a string. Deepgram does not parse it for you. */
  arguments: string
  /**
   * True when the client is expected to run it and reply.
   *
   * A function declared without a server `endpoint` is client-side, which is
   * every tool SHIVA exposes — they act on the interface running in this
   * browser, which Deepgram's servers cannot reach.
   */
  client_side: boolean
}

export interface FunctionCallRequestMessage {
  type: 'FunctionCallRequest'
  functions: FunctionCall[]
}

/**
 * Server → client.
 *
 * Deliberately not exhaustive, and every consumer must handle the default case:
 * the service adds message types without warning, and a client that treats an
 * unknown type as an error breaks on a Tuesday for no reason of its own.
 */
export type AgentMessage =
  | { type: 'Welcome'; request_id?: string }
  | { type: 'SettingsApplied' }
  | { type: 'ConversationText'; role: 'user' | 'assistant'; content: string }
  /** The user began talking. Stop playback immediately — this is barge-in. */
  | { type: 'UserStartedSpeaking' }
  | { type: 'AgentThinking'; content?: string }
  | { type: 'AgentStartedSpeaking' }
  /** The current utterance's audio is complete. */
  | { type: 'AgentAudioDone' }
  | FunctionCallRequestMessage
  | { type: 'Error'; description?: string; message?: string; code?: string }
  | { type: 'Warning'; description?: string }
  | { type: string; [key: string]: unknown }

export interface FunctionCallResponse {
  type: 'FunctionCallResponse'
  id: string
  name: string
  /** The result, as a string. Objects must be stringified by the caller. */
  content: string
}

/**
 * Builds the opening handshake.
 *
 * Sent once, immediately on open. The agent will not process audio until it has
 * been configured, so anything captured before `SettingsApplied` is discarded.
 */
export function buildSettings(prompt: string, functions: ToolDefinition[]): SettingsMessage {
  return {
    type: 'Settings',
    audio: {
      input: { encoding: 'linear16', sample_rate: SAMPLE_RATE },
      output: { encoding: 'linear16', sample_rate: SAMPLE_RATE, container: 'none' },
    },
    agent: {
      language: 'en',
      listen: { provider: { type: 'deepgram', model: MODELS.listen } },
      think: {
        provider: { type: MODELS.thinkProvider, model: MODELS.think },
        prompt,
        // Omitted rather than sent empty: an empty array is a different thing
        // from "no functions" to some providers, and provokes a schema error.
        ...(functions.length > 0 ? { functions } : {}),
      },
      speak: { provider: { type: 'deepgram', model: MODELS.speak } },
    },
  }
}

/**
 * Turns a close event into something a person can act on.
 *
 * Worth the code. A websocket that closes on a bad field reports `1008` and a
 * reason string, and the reason is the single most useful diagnostic the service
 * produces — it names the field. Swallowing it, which is the default if you only
 * log `event.code`, turns a two-minute fix into an afternoon.
 */
export function describeClose(code: number, reason: string): string {
  const detail = reason.trim()
  if (detail) return `Voice agent closed (${code}): ${detail}`

  switch (code) {
    case 1000:
      return 'Voice agent closed normally.'
    case 1006:
      // No close frame arrived, so the reason string is empty by definition.
      return 'Voice agent connection dropped. Check network access to agent.deepgram.com.'
    case 1008:
      return 'Voice agent rejected the session (policy). The API key may lack Voice Agent access.'
    case 1011:
      return 'Voice agent hit a server error. Retry shortly.'
    case 4001:
    case 4003:
      return 'Voice agent refused the credential. Check DEEPGRAM_API_KEY.'
    default:
      return `Voice agent closed (${code}).`
  }
}
