import type { ToolDefinition } from './types'
import { MODULES } from '@/core/config/modules'
import type { ModuleId } from '@/core/types'

/**
 * The command engine — what SHIVA can actually do.
 *
 * Two properties are deliberate:
 *
 * **Commands are bus events, not new machinery.** Every tool here resolves to
 * an event the gesture layer already publishes, so a voice command and a hand
 * gesture drive the identical code path. "Show me markets" and swiping to the
 * markets panel are the same operation, which means they can't drift apart.
 *
 * **The model is told what isn't live.** Panels whose data source lands in
 * Phase 3 are named in the system prompt as unavailable, because a model asked
 * about a portfolio it cannot see will otherwise invent a plausible one. That
 * is the single most damaging thing an assistant like this can do, and it costs
 * one sentence of prompt to prevent.
 */

export const TOOLS: ToolDefinition[] = [
  {
    name: 'focus_module',
    description:
      'Bring a specific module panel to the front of the carousel and expand it. Use when the user asks to see, open, or check a module.',
    parameters: {
      type: 'object',
      properties: {
        module: {
          type: 'string',
          enum: MODULES.map((m) => m.id),
          description: 'Which module to bring forward.',
        },
      },
      required: ['module'],
    },
  },
  {
    name: 'rotate_carousel',
    description:
      'Step the carousel one panel left or right. Use for relative navigation like "next" or "go back".',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['left', 'right'],
          description: 'Which way to step.',
        },
      },
      required: ['direction'],
    },
  },
  {
    name: 'dismiss',
    description:
      'Close the expanded panel and return to the carousel overview. Use for "close", "back", or "never mind".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'set_quality',
    description:
      'Change the render quality tier. Use when the user says the interface is slow or asks for higher fidelity.',
    parameters: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['tier'],
    },
  },
]

/** Modules with real data behind them right now. */
const liveModules = MODULES.filter((m) => m.liveIn === 1)
const pendingModules = MODULES.filter((m) => m.liveIn > 1)

export function buildSystemPrompt(context: {
  activeModule: ModuleId
  temperatureC?: number | null
  condition?: string | null
  location?: string | null
}): string {
  const conditions =
    context.temperatureC != null
      ? `Local conditions: ${context.temperatureC}°C, ${context.condition ?? 'unknown'}, ${context.location ?? 'unknown location'}.`
      : 'Local conditions are currently unavailable.'

  return [
    'You are SHIVA, a spatial computing assistant embedded in a 3D interface.',
    '',
    'Voice and manner:',
    '- Terse. One or two sentences unless asked to elaborate. Your replies are',
    '  spoken aloud and rendered as floating text, so length is a real cost.',
    '- Direct and unadorned. No preamble, no "certainly", no restating the',
    '  question back.',
    '',
    'You control the interface through tools. When the user asks to see',
    'something, call the tool — do not merely describe what you would do.',
    '',
    `The carousel currently shows: ${context.activeModule}.`,
    conditions,
    '',
    'What you can actually see right now:',
    `- Live data: ${liveModules.map((m) => m.id).join(', ')}.`,
    `- NOT yet connected: ${pendingModules.map((m) => m.id).join(', ')}.`,
    '',
    'This last point is not negotiable: for a module that is not yet connected,',
    'you may navigate to it, but you must not state or estimate any figure from',
    'it. Say plainly that the source is not connected yet. Inventing a number',
    'that looks real is worse than being unable to answer.',
  ].join('\n')
}
