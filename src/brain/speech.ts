/**
 * Web Speech API wrappers.
 *
 * The API is unevenly implemented and badly typed, and both problems bite:
 *
 *   - `SpeechRecognition` is `webkitSpeechRecognition` in Chromium and absent
 *     entirely in Firefox. Callers must handle "not supported" as a normal
 *     state, not an error — hence `isRecognitionSupported`, and hence the text
 *     input in the UI being a first-class path rather than a fallback.
 *   - Continuous recognition stops on its own after a silence, with no error.
 *     It has to be restarted from `onend`, and that restart needs a guard, or a
 *     revoked microphone permission turns into an infinite restart loop that
 *     pins a CPU core.
 *
 * TypeScript ships no DOM types for any of this, so the minimum surface is
 * declared here rather than pulling in a dependency for four interfaces.
 */

interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}

interface SpeechRecognitionResult {
  readonly length: number
  isFinal: boolean
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionResultList {
  readonly length: number
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number
  results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string
  message: string
}

export interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const isRecognitionSupported = (): boolean => getRecognitionCtor() !== null

export const createRecognition = (lang = 'en-US'): SpeechRecognitionLike | null => {
  const Ctor = getRecognitionCtor()
  if (!Ctor) return null
  const recognition = new Ctor()
  recognition.continuous = true
  recognition.interimResults = true
  recognition.lang = lang
  recognition.maxAlternatives = 1
  return recognition
}

/**
 * Detects the wake phrase and returns whatever followed it.
 *
 * Deliberately forgiving about spelling: speech engines transcribe "SHIVA"
 * as "Shiva", "Sheva", "Shivah" and "Siva" depending on accent and how the
 * word is stressed. Insisting on one spelling means the wake word works for
 * some users and not others, which reads as the feature being broken.
 *
 * @returns the command after the wake word, '' if the wake word was heard with
 *          nothing after it, or null if it wasn't heard at all.
 */
export function extractWakeCommand(transcript: string): string | null {
  const match = /\b(shiva|shivah|sheva|siva|shever)\b/i.exec(transcript)
  if (!match) return null
  return transcript.slice(match.index + match[0].length).replace(/^[\s,.:;!?-]+/, '')
}

/**
 * Speaks text aloud.
 *
 * Two behaviours worth knowing: `speechSynthesis` queues rather than replaces,
 * so a new utterance must cancel the old one or replies pile up and talk over
 * each other; and voice lists load asynchronously in Chrome, so the first call
 * after page load may find none — which is fine, the default voice is used.
 */
export function speak(text: string, { rate = 1.05, pitch = 0.95 } = {}): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  const trimmed = text.trim()
  if (!trimmed) return

  window.speechSynthesis.cancel()

  const utterance = new SpeechSynthesisUtterance(trimmed)
  utterance.rate = rate
  utterance.pitch = pitch
  utterance.volume = 0.9

  // Prefer a local voice: remote ones introduce a network round-trip before
  // any sound, which is the opposite of what a responsive assistant needs.
  const voices = window.speechSynthesis.getVoices()
  const preferred =
    voices.find(
      (v) => v.localService && /en-(GB|US)/.test(v.lang) && /natural|neural/i.test(v.name),
    ) ??
    voices.find((v) => v.localService && /en-(GB|US)/.test(v.lang)) ??
    voices.find((v) => v.lang.startsWith('en'))
  if (preferred) utterance.voice = preferred

  window.speechSynthesis.speak(utterance)
}

export function stopSpeaking(): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  window.speechSynthesis.cancel()
}

export const isSynthesisSupported = (): boolean =>
  typeof window !== 'undefined' && 'speechSynthesis' in window
