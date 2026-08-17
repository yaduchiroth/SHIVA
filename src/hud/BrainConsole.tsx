'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBrainStore } from '@/core/store/useBrainStore'
import type { BrainStatus } from '@/adapters/brain/types'
import { useBrain } from '@/brain/useBrain'
import { useVoice } from '@/brain/useVoice'
import { useVoiceAgent } from '@/brain/useVoiceAgent'
import { on } from '@/core/events/bus'
import { say } from '@/brain/speech'

/**
 * The conversational surface.
 *
 * Three ways in, deliberately: the wake phrase, the circle gesture, and typing.
 * The text input is not a fallback for when voice fails — it's the only path
 * that works in Firefox, in a noisy room, or when you don't want to talk aloud,
 * so it's a first-class control rather than a hidden escape hatch.
 *
 * There are now two kinds of voice, and they are genuinely different things
 * rather than one being a worse version of the other:
 *
 * **Live** opens a continuous socket to the voice agent — it hears you while it
 * talks, so you can interrupt it, and it answers without waiting for you to
 * finish a sentence. That is the conversational one.
 *
 * **Wake** is the older push-to-talk path: browser recognition listens for
 * "SHIVA…", sends one utterance to Gemini, speaks one reply. It costs nothing
 * while idle and works with no Deepgram key, which is why it stays.
 */
/**
 * Turns a probe result into a sentence someone can act on.
 *
 * The point of each of these being different: they have different fixes. A
 * missing key is a file on your machine, a rejected key is Google's console, a
 * retired model is one line of config. All three used to read "No API key — set
 * GEMINI_API_KEY in .env.local", which is actively misleading for two of them —
 * and was shown to someone whose key was, at that moment, working.
 *
 * @returns the problem, or null when there is nothing to say.
 */
function brainProblem(brain: BrainStatus | null): string | null {
  if (!brain) return null
  switch (brain.status) {
    case 'ready':
      return null
    case 'no-key':
      return 'The server got no GEMINI_API_KEY — run `npm run doctor`'
    case 'rejected':
      // Google's own words. It names the fix, and paraphrasing loses it.
      return `Gemini refused the key: ${brain.detail}`
    case 'model-missing':
      return `Model "${brain.model}" is not available to this key — set GEMINI_MODEL`
    case 'unreachable':
      return `Cannot reach Gemini: ${brain.detail}`
  }
}

export function BrainConsole() {
  const phase = useBrainStore((s) => s.phase)
  const brain = useBrainStore((s) => s.brain)
  const streaming = useBrainStore((s) => s.streaming)
  const transcript = useBrainStore((s) => s.transcript)
  const wakeArmed = useBrainStore((s) => s.wakeArmed)
  const error = useBrainStore((s) => s.error)

  const { ask } = useBrain()
  const { toggle, supported } = useVoice(ask)
  const { toggle: toggleAgent } = useVoiceAgent()

  const agentStatus = useBrainStore((s) => s.agentStatus)
  const [agentConfigured, setAgentConfigured] = useState<boolean | null>(null)

  // Probed once so the Live button can explain itself before it's pressed,
  // rather than failing on click with a server error.
  useEffect(() => {
    let cancelled = false
    fetch('/api/voice/token')
      .then((r) => r.json())
      .then((data: { configured: boolean }) => {
        if (!cancelled) setAgentConfigured(Boolean(data.configured))
      })
      .catch(() => {
        if (!cancelled) setAgentConfigured(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const [draft, setDraft] = useState('')
  const [typing, setTyping] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // The circle gesture is a wake, not a question — it opens the input so the
  // user can speak or type, rather than sending anything on its own.
  useEffect(() => {
    return on('brain:wake', () => {
      setTyping(true)
      requestAnimationFrame(() => input.current?.focus())
    })
  }, [])

  // Speak each reply once it's complete. Speaking during the stream would mean
  // restarting the utterance on every token.
  const spokenFor = useRef('')
  useEffect(() => {
    if (phase !== 'idle') return
    // The live agent speaks its own replies. Synthesising them a second time
    // here would play every answer twice, over itself.
    if (useBrainStore.getState().agentStatus !== 'off') return
    const last = useBrainStore.getState().messages.at(-1)
    if (last?.role !== 'assistant') return
    if (spokenFor.current === last.content) return
    spokenFor.current = last.content
    void say(last.content)
  }, [phase])

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault()
      const text = draft.trim()
      if (!text) return
      setDraft('')
      void ask(text)
    },
    [ask, draft],
  )

  // "/" focuses the input, the way it does in every developer tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== input.current) {
        e.preventDefault()
        setTyping(true)
        requestAnimationFrame(() => input.current?.focus())
      }
      if (e.key === 'Escape' && document.activeElement === input.current) {
        input.current?.blur()
        setTyping(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const status =
    error ??
    brainProblem(brain) ??
    (agentStatus === 'connecting'
      ? 'Connecting to voice agent…'
      : phase === 'listening'
        ? transcript ||
          (agentStatus === 'live' ? 'Listening — just talk' : 'Listening — say "SHIVA…"')
        : phase === 'thinking'
          ? 'Thinking'
          : phase === 'speaking'
            ? streaming.slice(-70)
            : wakeArmed
              ? 'Armed — say "SHIVA…"'
              : null)

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-20 flex flex-col items-center gap-2">
      {status && (
        <div
          className="glass-surface max-w-xl px-4 py-2 text-center"
          style={{
            fontSize: 'var(--text-hud)',
            letterSpacing: '0.08em',
            color: error ? 'var(--color-critical)' : 'var(--color-mist)',
          }}
          data-testid="brain-status"
        >
          {status}
        </div>
      )}

      <div className="pointer-events-auto flex items-center gap-2">
        <button
          type="button"
          onClick={toggleAgent}
          disabled={agentConfigured === false}
          className="glass-surface cursor-pointer px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            fontSize: 'var(--text-hud)',
            letterSpacing: 'var(--tracking-hud)',
            textTransform: 'uppercase',
            color:
              agentStatus === 'live'
                ? 'var(--color-nominal)'
                : agentStatus === 'error'
                  ? 'var(--color-critical)'
                  : 'var(--color-smoke)',
          }}
          title={
            agentConfigured === false
              ? 'Set DEEPGRAM_API_KEY in .env.local to enable live voice'
              : 'Continuous conversation — interrupt it any time'
          }
          data-testid="agent-toggle"
        >
          {agentStatus === 'live' ? '◉ Live' : agentStatus === 'connecting' ? '… Live' : 'Live'}
        </button>

        <button
          type="button"
          onClick={toggle}
          disabled={!supported || brain?.status === 'no-key'}
          className="glass-surface cursor-pointer px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            fontSize: 'var(--text-hud)',
            letterSpacing: 'var(--tracking-hud)',
            textTransform: 'uppercase',
            color: wakeArmed ? 'var(--color-nominal)' : 'var(--color-smoke)',
          }}
          title={
            supported ? 'Wake word, one turn at a time' : 'Speech recognition unsupported here'
          }
          data-testid="voice-toggle"
        >
          {wakeArmed ? '● Wake' : 'Wake'}
        </button>

        <form onSubmit={submit} className={typing ? 'block' : 'hidden'}>
          <input
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => !draft && setTyping(false)}
            placeholder="Ask SHIVA…"
            className="glass-surface w-80 px-3 py-1.5 outline-none"
            style={{ fontSize: 'var(--text-hud)', color: 'var(--color-bone)' }}
            data-testid="brain-input"
          />
        </form>

        {!typing && (
          <button
            type="button"
            onClick={() => {
              setTyping(true)
              requestAnimationFrame(() => input.current?.focus())
            }}
            className="glass-surface cursor-pointer px-3 py-1.5"
            style={{
              fontSize: 'var(--text-hud)',
              letterSpacing: 'var(--tracking-hud)',
              textTransform: 'uppercase',
              color: 'var(--color-smoke)',
            }}
          >
            Type /
          </button>
        )}
      </div>
    </div>
  )
}
