'use client'

import { create } from 'zustand'
import type { BrainStatus, Message } from '@/adapters/brain/types'

export type BrainPhase =
  | 'idle' // not listening, not thinking
  | 'listening' // microphone open, capturing speech
  | 'thinking' // request in flight, no tokens yet
  | 'speaking' // streaming a response
  | 'error'

/**
 * The live voice socket's own lifecycle.
 *
 * Kept separate from `phase` on purpose: phase describes the CONVERSATION
 * (listening, thinking, speaking) and applies equally to typed turns, while this
 * describes the CONNECTION. Collapsing them means a socket that dies mid-reply
 * has nowhere to say so — the UI would still read "speaking".
 */
export type AgentStatus = 'off' | 'connecting' | 'live' | 'error'

interface BrainState {
  phase: BrainPhase
  /**
   * What the server actually found when it asked the provider. Null until
   * probed.
   *
   * Was `configured: boolean | null`, which could not distinguish a missing key
   * from a rejected one from a retired model — three problems with three
   * different fixes, all shown as "no API key".
   */
  brain: BrainStatus | null
  /** Conversation history sent back with each turn. */
  messages: Message[]
  /** The response currently streaming in, assembled from deltas. */
  streaming: string
  /** Live speech-recognition text, before it's committed as a turn. */
  transcript: string
  /** Whether the wake word is armed and the mic is running. */
  wakeArmed: boolean
  /** State of the live voice-agent socket, independent of `phase`. */
  agentStatus: AgentStatus
  error: string | null

  setPhase: (phase: BrainPhase) => void
  setBrainStatus: (status: BrainStatus) => void
  setTranscript: (transcript: string) => void
  setWakeArmed: (armed: boolean) => void
  setAgentStatus: (status: AgentStatus) => void
  appendDelta: (delta: string) => void
  /** Commits the streamed response into history and clears the buffer. */
  commitResponse: () => void
  pushUser: (content: string) => void
  /**
   * Commits a complete assistant turn.
   *
   * The voice agent delivers finished utterances rather than token deltas, so it
   * has nothing to accumulate — `appendDelta` + `commitResponse` would mean
   * writing the whole string into the streaming buffer only to immediately move
   * it out again, and would fight with a typed turn streaming at the same time.
   */
  pushAssistant: (content: string) => void
  /** Records a tool result so the next turn can answer from it. */
  pushToolResult: (toolName: string, content: string, thoughtSignature?: string) => void
  setError: (error: string | null) => void
  reset: () => void
}

/** Keeps context bounded; the server trims too, but this bounds memory here. */
const MAX_HISTORY = 20

export const useBrainStore = create<BrainState>((set) => ({
  phase: 'idle',
  brain: null,
  messages: [],
  streaming: '',
  transcript: '',
  wakeArmed: false,
  agentStatus: 'off',
  error: null,

  setPhase: (phase) => set({ phase }),
  setBrainStatus: (brain) => set({ brain }),
  setTranscript: (transcript) => set({ transcript }),
  setWakeArmed: (wakeArmed) => set({ wakeArmed }),
  setAgentStatus: (agentStatus) => set({ agentStatus }),

  // Token-rate writes. Acceptable here and nowhere else: the response text is
  // genuinely what the UI must re-render, and tokens arrive at reading speed —
  // a few per second — not at frame rate.
  appendDelta: (delta) => set((s) => ({ streaming: s.streaming + delta })),

  commitResponse: () =>
    set((s) => {
      if (!s.streaming) return { streaming: '' }
      const next = [
        ...s.messages,
        { role: 'assistant' as const, content: s.streaming, at: Date.now() },
      ]
      return { messages: next.slice(-MAX_HISTORY), streaming: '' }
    }),

  pushUser: (content) =>
    set((s) => ({
      messages: [...s.messages, { role: 'user' as const, content, at: Date.now() }].slice(
        -MAX_HISTORY,
      ),
      transcript: '',
    })),

  pushAssistant: (content) =>
    set((s) => ({
      messages: [...s.messages, { role: 'assistant' as const, content, at: Date.now() }].slice(
        -MAX_HISTORY,
      ),
    })),

  pushToolResult: (toolName, content, thoughtSignature) =>
    set((s) => ({
      messages: [
        ...s.messages,
        { role: 'tool' as const, content, at: Date.now(), toolName, thoughtSignature },
      ].slice(-MAX_HISTORY),
    })),

  setError: (error) => set({ error, phase: error ? 'error' : 'idle' }),
  reset: () =>
    set({
      messages: [],
      streaming: '',
      transcript: '',
      error: null,
      phase: 'idle',
      agentStatus: 'off',
    }),
}))
