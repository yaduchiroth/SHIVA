'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBrainStore } from '@/core/store/useBrainStore'
import { useBrain } from '@/brain/useBrain'
import { useVoice } from '@/brain/useVoice'
import { on } from '@/core/events/bus'
import { speak } from '@/brain/speech'

/**
 * The conversational surface.
 *
 * Three ways in, deliberately: the wake phrase, the circle gesture, and typing.
 * The text input is not a fallback for when voice fails — it's the only path
 * that works in Firefox, in a noisy room, or when you don't want to talk aloud,
 * so it's a first-class control rather than a hidden escape hatch.
 */
export function BrainConsole() {
  const phase = useBrainStore((s) => s.phase)
  const configured = useBrainStore((s) => s.configured)
  const streaming = useBrainStore((s) => s.streaming)
  const transcript = useBrainStore((s) => s.transcript)
  const wakeArmed = useBrainStore((s) => s.wakeArmed)
  const error = useBrainStore((s) => s.error)

  const { ask } = useBrain()
  const { toggle, supported } = useVoice(ask)

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
    const last = useBrainStore.getState().messages.at(-1)
    if (last?.role !== 'assistant') return
    if (spokenFor.current === last.content) return
    spokenFor.current = last.content
    speak(last.content)
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
    (configured === false
      ? 'No API key — set GEMINI_API_KEY in .env.local'
      : phase === 'listening'
        ? transcript || 'Listening — say "SHIVA…"'
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
          onClick={toggle}
          disabled={!supported || configured === false}
          className="glass-surface cursor-pointer px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            fontSize: 'var(--text-hud)',
            letterSpacing: 'var(--tracking-hud)',
            textTransform: 'uppercase',
            color: wakeArmed ? 'var(--color-nominal)' : 'var(--color-smoke)',
          }}
          title={supported ? 'Toggle wake-word listening' : 'Speech recognition unsupported here'}
          data-testid="voice-toggle"
        >
          {wakeArmed ? '● Listening' : 'Voice'}
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
