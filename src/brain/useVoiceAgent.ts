'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useBrainStore } from '@/core/store/useBrainStore'
import { useSpatialStore, activeModuleIndex } from '@/core/store/useSpatialStore'
import { useSystemStore } from '@/core/store/useSystemStore'
import { getModule } from '@/core/config/modules'
import { emit } from '@/core/events/bus'
import { floatToInt16, int16ToFloat, resample } from '@/lib/pcm'
import { TOOLS, buildSystemPrompt } from '@/adapters/brain/commands'
import {
  ENDPOINT,
  FRAME_SAMPLES,
  SAMPLE_RATE,
  buildSettings,
  describeClose,
  type AgentMessage,
  type FunctionCallRequestMessage,
} from '@/adapters/voice/deepgram'
import { executeTool } from './executeTool'

/**
 * Live voice conversation over a single websocket.
 *
 * What this replaces is worth naming, because the difference is not incremental.
 * The previous path was three sequential steps: browser speech recognition
 * waited for you to stop talking, the whole utterance went to Gemini, and the
 * whole reply came back as audio. Every one of those steps is a hard barrier —
 * you cannot interrupt a reply that has already been synthesised, and you cannot
 * be heard while it plays. That is dictation, not conversation, and it is why
 * the old path sounded like one.
 *
 * Here, microphone audio streams up continuously and agent audio streams down,
 * and the agent decides when to talk. Interruption works because the moment the
 * service reports you started speaking, playback is cut mid-word — see
 * `stopPlayback`. That single behaviour is most of what makes it feel live.
 *
 * NOTE: this has not been run against the live service. See the header of
 * `src/adapters/voice/deepgram.ts` for what that means and what to check first.
 */

/**
 * The capture worklet.
 *
 * Inlined as a Blob rather than served from `public/`, so it cannot drift out of
 * sync with this file and needs no separate cache-busting. Blob URLs are
 * same-origin, so they load cleanly under the app's COEP policy — a worklet
 * fetched from a CDN would not.
 *
 * It does as little as possible: WebAudio calls `process` every 128 frames, and
 * posting a message that often would mean ~375 postMessage round trips a second.
 * Batching to a chunk first cuts that to roughly a dozen.
 */
const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.chunk = options.processorOptions.chunk
    this.buffer = new Float32Array(this.chunk)
    this.filled = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    // No input yet, or the track ended. Returning true keeps the node alive;
    // returning false would silently end capture for the rest of the session.
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i]
      if (this.filled === this.chunk) {
        // Transfer a copy: the buffer keeps being written into immediately.
        const out = this.buffer.slice(0)
        this.port.postMessage(out, [out.buffer])
        this.filled = 0
      }
    }
    return true
  }
}
registerProcessor('shiva-capture', Capture)
`

/**
 * Samples captured per postMessage, at the microphone's own rate.
 *
 * Sized so that after resampling to 24 kHz it lands near FRAME_SAMPLES for a
 * typical 48 kHz device. Not exact — device rates vary — and it does not need to
 * be: the socket carries whatever arrives.
 */
const CAPTURE_CHUNK = FRAME_SAMPLES * 2

/**
 * How far ahead of the clock playback is scheduled.
 *
 * Audio arrives in bursts over a websocket, so scheduling each buffer at
 * `currentTime` produces a gap wherever the network hiccups — heard as a click
 * between syllables. A small lead absorbs that. Larger would be safer and would
 * also delay the moment an interruption goes quiet, which is worse.
 */
const PLAYBACK_LEAD_S = 0.08

export function useVoiceAgent() {
  const setPhase = useBrainStore((s) => s.setPhase)
  const setError = useBrainStore((s) => s.setError)
  const setAgentStatus = useBrainStore((s) => s.setAgentStatus)
  const setTranscript = useBrainStore((s) => s.setTranscript)
  const pushUser = useBrainStore((s) => s.pushUser)
  const pushAssistant = useBrainStore((s) => s.pushAssistant)

  const socket = useRef<WebSocket | null>(null)
  const audio = useRef<AudioContext | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const capture = useRef<AudioWorkletNode | null>(null)
  const workletUrl = useRef<string | null>(null)

  /** Every scheduled output buffer, so an interruption can stop all of them. */
  const playing = useRef<Set<AudioBufferSourceNode>>(new Set())
  const playCursor = useRef(0)

  /** Set once the user asks to disconnect, so late callbacks stand down. */
  const wantRunning = useRef(false)

  /** Cuts agent audio instantly. This is what makes interruption work. */
  const stopPlayback = useCallback(() => {
    for (const source of playing.current) {
      try {
        source.stop()
      } catch {
        // Already ended; stop() on a finished source throws.
      }
    }
    playing.current.clear()
    playCursor.current = 0
  }, [])

  const disconnect = useCallback(() => {
    wantRunning.current = false
    stopPlayback()

    capture.current?.port.close()
    capture.current?.disconnect()
    capture.current = null

    // Order matters: close the socket before tearing down audio, so a final
    // frame can't be posted onto a dead context.
    const ws = socket.current
    socket.current = null
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close(1000, 'client closed')
    }

    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null

    void audio.current?.close().catch(() => {
      /* already closed */
    })
    audio.current = null

    if (workletUrl.current) {
      URL.revokeObjectURL(workletUrl.current)
      workletUrl.current = null
    }

    setAgentStatus('off')
    setTranscript('')
    if (useBrainStore.getState().phase !== 'error') setPhase('idle')
  }, [setAgentStatus, setPhase, setTranscript, stopPlayback])

  /** Plays one binary audio frame, scheduled back-to-back with the last. */
  const enqueueAudio = useCallback((data: ArrayBuffer) => {
    const context = audio.current
    if (!context || context.state === 'closed') return

    const samples = int16ToFloat(data)
    if (samples.length === 0) return

    // The buffer is created at the agent's rate, not the context's; WebAudio
    // resamples on playback. Creating it at the context rate instead would play
    // the speech at the wrong pitch, which sounds like a different voice rather
    // than like a bug.
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE)
    buffer.copyToChannel(samples, 0)

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)

    const now = context.currentTime
    // Restart the cursor whenever it has fallen behind — after an interruption,
    // or a gap in the stream. Scheduling in the past plays everything at once.
    if (playCursor.current < now + PLAYBACK_LEAD_S) {
      playCursor.current = now + PLAYBACK_LEAD_S
    }
    source.start(playCursor.current)
    playCursor.current += buffer.duration

    playing.current.add(source)
    source.onended = () => playing.current.delete(source)
  }, [])

  const handleMessage = useCallback(
    (message: AgentMessage) => {
      switch (message.type) {
        case 'Welcome':
          break

        case 'SettingsApplied':
          setAgentStatus('live')
          setPhase('listening')
          emit('ui:confirm', { intensity: 0.8 })
          break

        case 'UserStartedSpeaking':
          // Barge-in. Everything queued is now stale — the user is talking over
          // it, and continuing to play would talk over them back.
          stopPlayback()
          setPhase('listening')
          break

        case 'AgentThinking':
          setPhase('thinking')
          break

        case 'AgentStartedSpeaking':
          setPhase('speaking')
          break

        case 'AgentAudioDone':
          setPhase('listening')
          break

        case 'ConversationText': {
          const text = String(message.content ?? '')
          if (!text) break
          // Recorded into the same history the typed conversation uses, so the
          // transcript reads as one conversation rather than two.
          if (message.role === 'user') pushUser(text)
          else pushAssistant(text)
          setTranscript('')
          break
        }

        case 'FunctionCallRequest': {
          const ws = socket.current
          // The union carries a catch-all member for message types the service
          // adds later, and that member's index signature defeats narrowing on
          // `type` alone — hence the explicit cast rather than relying on it.
          const request = message as FunctionCallRequestMessage
          for (const call of request.functions ?? []) {
            // Server-side functions are Deepgram's to run; replying to one would
            // be answering a question we were not asked.
            if (call.client_side === false) continue

            let args: Record<string, unknown> = {}
            try {
              args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
            } catch {
              // Malformed arguments still need a reply, or the agent waits
              // forever for a response that is never coming.
            }

            const result = executeTool(call.name, args)
            emit('ui:confirm', { intensity: 0.5 })

            ws?.send(
              JSON.stringify({
                type: 'FunctionCallResponse',
                id: call.id,
                name: call.name,
                content: result,
              }),
            )
          }
          break
        }

        case 'Error': {
          const detail = String(message.description ?? message.message ?? 'unknown')
          setError(`Voice agent error: ${detail}`)
          break
        }

        case 'Warning':
          console.warn('[voice]', message.description)
          break

        default:
          // Unknown types are normal — the service adds them. Logging rather
          // than erroring keeps a new message type from breaking the session.
          break
      }
    },
    [pushAssistant, pushUser, setAgentStatus, setError, setPhase, setTranscript, stopPlayback],
  )

  const connect = useCallback(async () => {
    if (wantRunning.current) return
    wantRunning.current = true
    setError(null)
    setAgentStatus('connecting')

    // ── Credential ───────────────────────────────────────────────────────────
    // Minted server-side and short-lived. The real API key must never reach
    // here: a websocket subprotocol is visible to anything running on the page.
    let token: string
    try {
      const res = await fetch('/api/voice/token', { method: 'POST' })
      const body = (await res.json()) as { token?: string; error?: string; detail?: string }
      if (!res.ok || !body.token) {
        throw new Error(body.error ?? `token request returned ${res.status}`)
      }
      token = body.token
    } catch (err) {
      wantRunning.current = false
      setAgentStatus('error')
      setError(`Voice unavailable: ${(err as Error).message}`)
      return
    }

    // ── Microphone ───────────────────────────────────────────────────────────
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          // The agent does its own endpointing, but these are still worth
          // asking for: without echo cancellation the microphone hears the
          // agent's own voice through the speakers and interrupts itself.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      })
    } catch (err) {
      wantRunning.current = false
      setAgentStatus('error')
      const denied = err instanceof DOMException && err.name === 'NotAllowedError'
      setError(
        denied ? 'Microphone access denied.' : `Microphone unavailable: ${(err as Error).message}`,
      )
      return
    }

    // ── Audio graph ──────────────────────────────────────────────────────────
    try {
      // The requested rate is a hint only — Chrome frequently ignores it and
      // returns the device rate. Everything downstream reads the ACTUAL rate
      // off the context rather than assuming this was honoured; assuming is how
      // audio ends up transcribed at half speed.
      const context = new AudioContext({ sampleRate: SAMPLE_RATE })
      audio.current = context

      const blob = new Blob([CAPTURE_WORKLET], { type: 'application/javascript' })
      workletUrl.current = URL.createObjectURL(blob)
      await context.audioWorklet.addModule(workletUrl.current)

      const source = context.createMediaStreamSource(stream.current)
      const node = new AudioWorkletNode(context, 'shiva-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { chunk: CAPTURE_CHUNK },
      })
      capture.current = node
      source.connect(node)
    } catch (err) {
      setAgentStatus('error')
      setError(`Audio setup failed: ${(err as Error).message}`)
      disconnect()
      return
    }

    if (!wantRunning.current) {
      // Disconnected while we were awaiting permission or the worklet.
      disconnect()
      return
    }

    // ── Socket ───────────────────────────────────────────────────────────────
    // Browsers cannot set headers on a WebSocket, so the credential rides in the
    // subprotocol. This is the only place it appears client-side.
    const ws = new WebSocket(ENDPOINT, ['bearer', token])
    ws.binaryType = 'arraybuffer'
    socket.current = ws

    ws.onopen = () => {
      const spatial = useSpatialStore.getState()
      const telemetry = useSystemStore.getState().telemetry
      const prompt = buildSystemPrompt({
        activeModule: getModule(activeModuleIndex(spatial.index)).id,
        temperatureC: telemetry?.temperatureC ?? null,
        condition: telemetry?.condition ?? null,
        location: telemetry?.location ?? null,
      })

      // The same tools the typed brain uses. Sharing them is what keeps spoken
      // and typed answers reading the same live data rather than two sources.
      ws.send(JSON.stringify(buildSettings(prompt, TOOLS)))

      const context = audio.current
      const node = capture.current
      if (!context || !node) return

      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (ws.readyState !== WebSocket.OPEN) return
        // Resample from whatever the device actually runs at. When the context
        // honoured the requested rate this is a no-op and returns the input.
        const resampled = resample(event.data, context.sampleRate, SAMPLE_RATE)
        ws.send(floatToInt16(resampled))
      }
    }

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        enqueueAudio(event.data)
        return
      }
      try {
        handleMessage(JSON.parse(String(event.data)) as AgentMessage)
      } catch {
        // Not JSON and not audio — nothing useful to do with it.
      }
    }

    ws.onerror = () => {
      // The error event carries no detail by design (it would leak cross-origin
      // information). The close event that follows does, so report from there.
    }

    ws.onclose = (event) => {
      if (!wantRunning.current) return
      const message = describeClose(event.code, event.reason)
      setAgentStatus('error')
      setError(message)
      disconnect()
    }
  }, [disconnect, enqueueAudio, handleMessage, setAgentStatus, setError])

  const toggle = useCallback(() => {
    if (wantRunning.current) disconnect()
    else void connect()
  }, [connect, disconnect])

  useEffect(() => disconnect, [disconnect])

  return { connect, disconnect, toggle }
}
