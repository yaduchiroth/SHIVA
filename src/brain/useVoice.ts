'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useBrainStore } from '@/core/store/useBrainStore'
import { emit } from '@/core/events/bus'
import {
  createRecognition,
  extractWakeCommand,
  isRecognitionSupported,
  speak,
  stopSpeaking,
  type SpeechRecognitionLike,
} from './speech'

/**
 * Wake-word listening and spoken replies.
 *
 * The listening model: recognition runs continuously once armed, but nothing is
 * sent to the brain until the wake phrase is heard. That keeps the microphone
 * useful without making every stray remark in the room a prompt.
 *
 * Restarting is the fiddly part. Continuous recognition ends by itself after a
 * silence, so `onend` has to restart it — but if the microphone has been
 * revoked, `start()` fails immediately and calls `onend` again, which restarts
 * again. Left unguarded that is an infinite loop that pins a CPU core. The
 * backoff and the consecutive-failure cap below exist for exactly that.
 */

const RESTART_DELAY_MS = 400
const MAX_CONSECUTIVE_FAILURES = 5

export function useVoice(onCommand: (text: string) => void) {
  const setWakeArmed = useBrainStore((s) => s.setWakeArmed)
  const setTranscript = useBrainStore((s) => s.setTranscript)
  const setPhase = useBrainStore((s) => s.setPhase)
  const setError = useBrainStore((s) => s.setError)

  const recognition = useRef<SpeechRecognitionLike | null>(null)
  const wantRunning = useRef(false)
  const failures = useRef(0)
  const restartTimer = useRef<number | null>(null)
  // Held in a ref so the recognition handlers, which are bound once, always
  // call the current callback rather than the one captured at setup.
  const commandHandler = useRef(onCommand)
  commandHandler.current = onCommand

  const stop = useCallback(() => {
    wantRunning.current = false
    if (restartTimer.current !== null) {
      clearTimeout(restartTimer.current)
      restartTimer.current = null
    }
    recognition.current?.abort()
    recognition.current = null
    stopSpeaking()
    setWakeArmed(false)
    setTranscript('')
    setPhase('idle')
  }, [setPhase, setTranscript, setWakeArmed])

  const start = useCallback(() => {
    if (wantRunning.current) return

    if (!isRecognitionSupported()) {
      setError(
        'Speech recognition is unavailable in this browser. Chrome or Edge support it; type instead.',
      )
      return
    }

    const instance = createRecognition()
    if (!instance) return

    recognition.current = instance
    wantRunning.current = true
    failures.current = 0
    setWakeArmed(true)
    setPhase('listening')

    instance.onresult = (event) => {
      let interim = ''
      let final = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (!result) continue
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) final += text
        else interim += text
      }

      // Interim text is shown live so the user can see they're being heard —
      // silence during recognition is indistinguishable from a dead mic.
      if (interim) setTranscript(interim)

      if (!final) return

      const command = extractWakeCommand(final)
      if (command === null) {
        // Heard, but not addressed to SHIVA.
        setTranscript('')
        return
      }

      if (command.length === 0) {
        // Woken with nothing after it — acknowledge and wait for the follow-up
        // rather than sending an empty prompt.
        emit('ui:confirm', { intensity: 0.7 })
        setTranscript('…')
        return
      }

      emit('ui:confirm', { intensity: 0.7 })
      setTranscript('')
      commandHandler.current(command)
    }

    instance.onerror = (event) => {
      // 'no-speech' and 'aborted' are routine: someone paused, or we stopped it.
      if (event.error === 'no-speech' || event.error === 'aborted') return

      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        wantRunning.current = false
        setError('Microphone access denied. Voice is off; type instead.')
        setWakeArmed(false)
        return
      }
      failures.current += 1
    }

    instance.onend = () => {
      if (!wantRunning.current) return

      if (failures.current >= MAX_CONSECUTIVE_FAILURES) {
        wantRunning.current = false
        setWakeArmed(false)
        setError('Speech recognition kept failing; voice disabled.')
        return
      }

      // Continuous mode ends itself on silence — restart to keep listening.
      restartTimer.current = window.setTimeout(() => {
        if (!wantRunning.current) return
        try {
          instance.start()
        } catch {
          // Already starting; the next onend will retry.
          failures.current += 1
        }
      }, RESTART_DELAY_MS)
    }

    try {
      instance.start()
    } catch (err) {
      wantRunning.current = false
      setWakeArmed(false)
      setError(`Could not start listening: ${(err as Error).message}`)
    }
  }, [setError, setPhase, setTranscript, setWakeArmed])

  const toggle = useCallback(() => {
    if (wantRunning.current) stop()
    else start()
  }, [start, stop])

  useEffect(() => stop, [stop])

  return { start, stop, toggle, speak, supported: isRecognitionSupported() }
}
