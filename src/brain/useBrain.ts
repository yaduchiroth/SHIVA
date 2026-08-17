'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { BrainEvent } from '@/adapters/brain/types'
import { useBrainStore } from '@/core/store/useBrainStore'
import { useSpatialStore, activeModuleIndex } from '@/core/store/useSpatialStore'
import { useSystemStore } from '@/core/store/useSystemStore'
import { MODULES, getModule } from '@/core/config/modules'
import { emit } from '@/core/events/bus'
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
        if (controller.signal.aborted) return
        setError(`Could not reach SHIVA's brain: ${(err as Error).message}`)
        return
      }

      if (!response.ok || !response.body) {
        setError(`Brain returned ${response.status}.`)
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let sawAnything = false

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          // Frames end on a blank line; the tail is a partial frame and must
          // stay buffered or its JSON gets cut mid-object.
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''

          for (const frame of frames) {
            const line = frame.split('\n').find((l) => l.startsWith('data:'))
            if (!line) continue
            let event: BrainEvent
            try {
              event = JSON.parse(line.slice(5).trim()) as BrainEvent
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
                // Kept out of the transcript deliberately: the user sees the
                // interface move, which is better feedback than a line of text
                // describing that it moved.
                if (process.env.NODE_ENV === 'development') {
                  console.info(`[brain] ${event.name} → ${result}`)
                }
                break
              }

              case 'error':
                setError(event.message)
                return

              case 'done':
                break
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(`Stream interrupted: ${(err as Error).message}`)
        }
        return
      } finally {
        reader.releaseLock()
        inFlight.current = null
      }

      commitResponse()
      setPhase('idle')
    },
    [appendDelta, cancel, commitResponse, pushUser, setError, setPhase],
  )

  useEffect(() => cancel, [cancel])

  return { ask, cancel }
}
