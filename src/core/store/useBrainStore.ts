'use client'

import { create } from 'zustand'
import type { Message } from '@/adapters/brain/types'

export type BrainPhase =
  | 'idle' // not listening, not thinking
  | 'listening' // microphone open, capturing speech
  | 'thinking' // request in flight, no tokens yet
  | 'speaking' // streaming a response
  | 'error'

interface BrainState {
  phase: BrainPhase
  /** Whether the server has an API key. Null until probed. */
  configured: boolean | null
  /** Conversation history sent back with each turn. */
  messages: Message[]
  /** The response currently streaming in, assembled from deltas. */
  streaming: string
  /** Live speech-recognition text, before it's committed as a turn. */
  transcript: string
  /** Whether the wake word is armed and the mic is running. */
  wakeArmed: boolean
  error: string | null

  setPhase: (phase: BrainPhase) => void
  setConfigured: (configured: boolean) => void
  setTranscript: (transcript: string) => void
  setWakeArmed: (armed: boolean) => void
  appendDelta: (delta: string) => void
  /** Commits the streamed response into history and clears the buffer. */
  commitResponse: () => void
  pushUser: (content: string) => void
  setError: (error: string | null) => void
  reset: () => void
}

/** Keeps context bounded; the server trims too, but this bounds memory here. */
const MAX_HISTORY = 20

export const useBrainStore = create<BrainState>((set) => ({
  phase: 'idle',
  configured: null,
  messages: [],
  streaming: '',
  transcript: '',
  wakeArmed: false,
  error: null,

  setPhase: (phase) => set({ phase }),
  setConfigured: (configured) => set({ configured }),
  setTranscript: (transcript) => set({ transcript }),
  setWakeArmed: (wakeArmed) => set({ wakeArmed }),

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

  setError: (error) => set({ error, phase: error ? 'error' : 'idle' }),
  reset: () => set({ messages: [], streaming: '', transcript: '', error: null, phase: 'idle' }),
}))
