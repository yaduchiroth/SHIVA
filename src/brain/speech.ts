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

/** Playback handle for neural audio, so a new utterance can stop the old one. */
let currentSource: AudioBufferSourceNode | null = null
let audioContext: AudioContext | null = null

/**
 * Which voice actually spoke last, and why it was not the first choice.
 *
 * Worth tracking because the failure is invisible otherwise: a Deepgram key
 * that is wrong, expired, or naming a model the account cannot use produces a
 * reply that is still spoken — by Gemini — and sounds fine. Someone would
 * reasonably conclude the good voice was working.
 */
export type SpeechProvider = 'deepgram' | 'gemini' | 'browser' | 'none'

let lastProvider: SpeechProvider = 'none'
let lastFallback: string | null = null
/** Warned-about failures, so a broken key logs once rather than once per reply. */
const warned = new Set<string>()

export const speechProvider = (): SpeechProvider => lastProvider

/** Why the preferred provider was not used, if it was not. Null when all is well. */
export const speechFallbackReason = (): string | null => lastFallback

/**
 * Whether the browser will actually let SHIVA make a sound yet.
 *
 * Chrome suspends every `AudioContext` created without a prior user gesture and
 * refuses to resume it, so a page that has never been clicked cannot play
 * audio — no error, just silence. That matters most for the one utterance
 * nobody clicks first: the greeting when SHIVA recognises you on a fresh tab.
 */
export const isAudioUnlocked = (): boolean =>
  audioContext === null || audioContext.state === 'running'

/**
 * Resumes audio on the first interaction of any kind, whatever it was.
 *
 * Without this, the greeting is silent until the user happens to click
 * something that itself makes a sound — and the first thing anyone does on this
 * interface is wave at it, which is not a gesture the browser counts. Any
 * pointer or key event anywhere in the document is enough, so pressing a HUD
 * button, typing, or even dismissing something all arm it. Once.
 */
export function primeAudioOnGesture(): void {
  if (typeof window === 'undefined') return

  const prime = () => {
    // Created here rather than waited for: a context made inside a gesture
    // starts running, whereas one made at page load starts suspended and has
    // to be resumed — and `resume()` outside a gesture is what silently fails.
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    audioContext ??= new Ctor()
    void audioContext.resume().catch(() => {
      // Still refused. Nothing more to do — speech falls back to the browser's
      // own synthesis, which is subject to the same policy and will also stay
      // quiet until the browser is satisfied.
    })
  }

  window.addEventListener('pointerdown', prime, { once: true, capture: true })
  window.addEventListener('keydown', prime, { once: true, capture: true })
}

/**
 * Speaks text using neural TTS, falling back to the browser.
 *
 * The browser's own voices are the reason an assistant sounds synthetic: flat
 * prosody, wrong emphasis, no sense of a sentence. Neural audio fixes that, at
 * the cost of latency — nothing plays until the whole utterance is generated.
 *
 * So the fallback is not a lesser path, it is the *fast* path: if the neural
 * request fails or the key is absent, speaking still happens immediately rather
 * than not at all.
 */
export async function speakNeural(text: string, voice?: string): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed || typeof window === 'undefined') return false

  try {
    const res = await fetch('/api/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: trimmed, voice }),
    })
    if (!res.ok) return false

    const { audio, sampleRate, provider, fellBackFrom } = (await res.json()) as {
      audio: string
      sampleRate: number
      provider?: SpeechProvider
      fellBackFrom?: { error: string; detail: string }
    }
    if (!audio) return false

    lastProvider = provider ?? 'gemini'
    lastFallback = fellBackFrom ? `${fellBackFrom.error}: ${fellBackFrom.detail}` : null
    if (lastFallback && !warned.has(lastFallback)) {
      warned.add(lastFallback)
      // Once per distinct failure. A wrong key would otherwise print this on
      // every single reply, which is how a useful warning becomes noise people
      // filter out.
      console.warn(`[speech] falling back to ${lastProvider}. ${lastFallback}`)
    }

    // base64 → bytes → signed 16-bit samples → float. The model returns raw
    // PCM with no container, so decodeAudioData can't be used directly.
    const binary = atob(audio)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

    const samples = new Int16Array(bytes.buffer)
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return false

    audioContext ??= new Ctor()
    if (audioContext.state === 'suspended') await audioContext.resume()

    const buffer = audioContext.createBuffer(1, samples.length, sampleRate || 24000)
    const channel = buffer.getChannelData(0)
    // Int16 → normalised float. 32768 rather than 32767: the negative range is
    // one larger, and dividing by 32767 clips the loudest negative sample.
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i]! / 32768

    stopSpeaking()
    const source = audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(audioContext.destination)
    source.onended = () => {
      if (currentSource === source) currentSource = null
    }
    source.start()
    currentSource = source
    return true
  } catch {
    return false
  }
}

/**
 * Speaks text with the browser's built-in synthesis.
 *
 * Two behaviours worth knowing: `speechSynthesis` queues rather than replaces,
 * so a new utterance must cancel the old one or replies pile up and talk over
 * each other; and voice lists load asynchronously in Chrome, so the first call
 * after page load may find none — which is fine, the default voice is used.
 */
export function speak(text: string, { rate = 1.02, pitch = 1.0 } = {}): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  const trimmed = text.trim()
  if (!trimmed) return

  window.speechSynthesis.cancel()

  const utterance = new SpeechSynthesisUtterance(trimmed)
  utterance.rate = rate
  utterance.pitch = pitch
  utterance.volume = 0.9

  // Voice choice matters more than any parameter here. macOS ships genuinely
  // good voices behind names the generic heuristics miss — the Premium and
  // Enhanced variants are a different class from the default Alex/Fred, and
  // "Siri" voices are better still. Ordered best-first.
  const voices = window.speechSynthesis.getVoices()
  const byPreference = [
    /siri/i,
    /(premium|enhanced)/i,
    /(natural|neural)/i,
    /(samantha|serena|karen|daniel|moira)/i,
  ]
  let preferred: SpeechSynthesisVoice | undefined
  for (const pattern of byPreference) {
    preferred = voices.find((v) => v.lang.startsWith('en') && pattern.test(v.name))
    if (preferred) break
  }
  // Fall back to any local English voice: remote ones add a network round-trip
  // before any sound, which is the opposite of responsive.
  preferred ??= voices.find((v) => v.localService && v.lang.startsWith('en'))
  preferred ??= voices.find((v) => v.lang.startsWith('en'))
  if (preferred) utterance.voice = preferred

  window.speechSynthesis.speak(utterance)
}

export function stopSpeaking(): void {
  if (typeof window === 'undefined') return
  window.speechSynthesis?.cancel()
  if (currentSource) {
    try {
      currentSource.stop()
    } catch {
      // Already finished; nothing to stop.
    }
    currentSource = null
  }
}

/**
 * Speaks, preferring neural audio and falling back to the browser.
 *
 * The fallback is synchronous on purpose: if neural synthesis is going to fail,
 * it should fail into speech rather than into silence.
 */
export async function say(text: string, voice?: string): Promise<void> {
  const spoken = await speakNeural(text, voice)
  if (spoken) return
  lastProvider = 'browser'
  speak(text)
}

export const isSynthesisSupported = (): boolean =>
  typeof window !== 'undefined' && 'speechSynthesis' in window
