'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { BrainEvent } from '@/adapters/brain/types'
import { useBrainStore } from '@/core/store/useBrainStore'
import { useSpatialStore, activeModuleIndex } from '@/core/store/useSpatialStore'
import { useSystemStore } from '@/core/store/useSystemStore'
import { MODULES, getModule } from '@/core/config/modules'
import { emit } from '@/core/events/bus'
import { SseFramer, sseData } from '@/lib/sse'
import { readPanel } from '@/spatial/carousel/panelContent'
import type { ModuleId, QualityTierName } from '@/core/types'

/**
 * The brain client: sends a turn, streams the reply, executes tool calls.
 *
 * Tool calls resolve to bus events — the same ones the gesture recognizer
 * publishes. A spoken "show me markets" and a swipe to the markets panel end up
 * in identical code, which is the only way to stop the two input paths drifting
 * apart as the interface grows.
 */

/** Maps a tool call to interface actions. Returns what happened, for the log. */
function executeTool(name: string, args: Record<string, unknown>): string {
  const spatial = useSpatialStore.getState()

  switch (name) {
    case 'focus_module': {
      const moduleId = args.module as ModuleId
      const index = MODULES.findIndex((m) => m.id === moduleId)
      if (index < 0) return `unknown module: ${moduleId}`

      // The carousel index is unbounded and wraps, so stepping to a specific
      // panel means finding the shortest path from wherever it currently is —
      // not assigning an absolute index, which could spin it the long way round.
      const current = spatial.index
      const currentSlot = activeModuleIndex(current)
      let delta = index - currentSlot
      const count = MODULES.length
      if (delta > count / 2) delta -= count
      if (delta < -count / 2) delta += count

      spatial.setIndex(current + delta)
      spatial.focus(index)
      return `focused ${moduleId}`
    }

    case 'rotate_carousel': {
      const direction = args.direction === 'left' ? -1 : 1
      emit('carousel:step', { direction })
      return `rotated ${args.direction}`
    }

    case 'dismiss': {
      spatial.focus(null)
      return 'dismissed'
    }

    case 'read_module': {
      // Returns the same readout the panel renders, so what SHIVA says and what
      // you can see on the panel are the same numbers by construction.
      const readout = readPanel(args.module as ModuleId)
      if (readout.status !== 'live') {
        return `${args.module}: no live data (${readout.note})`
      }
      const rows = readout.rows.map((r) => `${r.label}: ${r.value}`).join('; ')
      return `${args.module}: ${readout.headline} — ${readout.caption}. ${rows}`
    }

    case 'set_quality': {
      const tier = args.tier as QualityTierName
      if (tier !== 'low' && tier !== 'medium' && tier !== 'high') return `unknown tier: ${tier}`
      useSystemStore.getState().setTier(tier)
      return `quality set to ${tier}`
    }

    default:
      return `unknown tool: ${name}`
  }
}

export function useBrain() {
  const setPhase = useBrainStore((s) => s.setPhase)
  const setConfigured = useBrainStore((s) => s.setConfigured)
  const setError = useBrainStore((s) => s.setError)
  const appendDelta = useBrainStore((s) => s.appendDelta)
  const commitResponse = useBrainStore((s) => s.commitResponse)
  const pushUser = useBrainStore((s) => s.pushUser)
  const pushToolResult = useBrainStore((s) => s.pushToolResult)

  const inFlight = useRef<AbortController | null>(null)

  // Probe once so the UI can say "no API key" before the user talks to a wall.
  useEffect(() => {
    let cancelled = false
    fetch('/api/brain')
      .then((r) => r.json())
      .then((data: { configured: boolean }) => {
        if (!cancelled) setConfigured(Boolean(data.configured))
      })
      .catch(() => {
        if (!cancelled) setConfigured(false)
      })
    return () => {
      cancelled = true
    }
  }, [setConfigured])

  const cancel = useCallback(() => {
    inFlight.current?.abort()
    inFlight.current = null
  }, [])

  /**
   * Runs one request/response turn.
   *
   * @returns tool results worth feeding back, if any.
   */
  const runTurn = useCallback(
    async (
      controller: AbortController,
    ): Promise<{ name: string; result: string; signature?: string }[]> => {
      const pending: { name: string; result: string; signature?: string }[] = []

      const spatial = useSpatialStore.getState()
      const telemetry = useSystemStore.getState().telemetry

      let response: Response
      try {
        response = await fetch('/api/brain', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            messages: useBrainStore.getState().messages,
            context: {
              activeModule: getModule(activeModuleIndex(spatial.index)).id,
              temperatureC: telemetry?.temperatureC ?? null,
              condition: telemetry?.condition ?? null,
              location: telemetry?.location ?? null,
            },
          }),
        })
      } catch (err) {
        if (controller.signal.aborted) return pending
        setError(`Could not reach SHIVA's brain: ${(err as Error).message}`)
        return pending
      }

      if (!response.ok || !response.body) {
        setError(`Brain returned ${response.status}.`)
        return pending
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const framer = new SseFramer()
      let sawAnything = false

      try {
        while (true) {
          const { done, value } = await reader.read()
          const frames = done
            ? framer.flush()
            : framer.push(decoder.decode(value, { stream: true }))

          for (const frame of frames) {
            const payload = sseData(frame)
            if (!payload) continue
            let event: BrainEvent
            try {
              event = JSON.parse(payload) as BrainEvent
            } catch {
              continue
            }

            switch (event.type) {
              case 'text':
                if (!sawAnything) {
                  sawAnything = true
                  setPhase('speaking')
                }
                appendDelta(event.delta)
                break

              case 'tool-call': {
                const result = executeTool(event.name, event.args)
                emit('ui:confirm', { intensity: 0.5 })

                // Only reads need feeding back. An action like focus_module is
                // its own feedback — the interface moved — and replaying it to
                // the model just spends a round trip to be told "done".
                if (event.name === 'read_module') {
                  pending.push({
                    name: event.name,
                    result,
                    signature: event.thoughtSignature,
                  })
                }
                break
              }

              case 'error':
                setError(event.message)
                return pending

              case 'done':
                break
            }
          }

          if (done) break
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(`Stream interrupted: ${(err as Error).message}`)
        }
        return pending
      } finally {
        reader.releaseLock()
      }

      return pending
    },
    [appendDelta, setError, setPhase],
  )

  const ask = useCallback(
    async (prompt: string) => {
      const text = prompt.trim()
      if (!text) return

      // A new question supersedes whatever is still streaming.
      cancel()
      const controller = new AbortController()
      inFlight.current = controller

      pushUser(text)
      setError(null)
      setPhase('thinking')

      try {
        // At most one follow-up. A read tool answers in a single extra turn,
        // and an unbounded loop is how a tool-calling agent quietly spends a
        // rate limit arguing with itself.
        for (let round = 0; round < 2; round++) {
          const pending = await runTurn(controller)
          if (controller.signal.aborted) return
          if (pending.length === 0) break

          // Commit any text from this round before the follow-up overwrites the
          // streaming buffer.
          commitResponse()
          for (const call of pending) {
            pushToolResult(call.name, call.result, call.signature)
          }
          setPhase('thinking')
        }
      } finally {
        inFlight.current = null
      }

      commitResponse()
      if (useBrainStore.getState().phase !== 'error') setPhase('idle')
    },
    [cancel, commitResponse, pushToolResult, pushUser, runTurn, setError, setPhase],
  )

  useEffect(() => cancel, [cancel])

  return { ask, cancel }
}
