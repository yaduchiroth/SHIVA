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
    name: 'read_module',
    description:
      "Read the current live data for a module. Call this before answering any question about the user's system performance, local weather, or repositories — never answer from memory or assumption.",
    parameters: {
      type: 'object',
      properties: {
        module: {
          type: 'string',
          enum: ['system', 'weather', 'projects'],
          description: 'Which module to read. Only these have live sources.',
        },
      },
      required: ['module'],
    },
  },
  {
    name: 'show_card',
    description:
      'Put a short written note on a floating AR surface in the room. Use for a summary, an answer worth keeping visible, or a list of a few items. For anything with structure — tables, headings, columns — use show_report instead.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short label for the surface header.' },
        body: { type: 'string', description: 'Plain text. Line breaks are preserved.' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'show_report',
    description:
      'Put a rich HTML report on a floating AR surface: headings, tables, lists, inline SVG. Dark theme is applied automatically — do not set background colours or fonts. Scripts do not run, so do not include any. Use when the user asks for a report, breakdown, comparison or dashboard that a single card cannot hold.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        html: { type: 'string', description: 'Body markup only — no <html>, <head> or <script>.' },
      },
      required: ['title', 'html'],
    },
  },
  {
    name: 'show_chart',
    description:
      'Plot numeric series on a floating AR surface. The axis starts at zero, so send real magnitudes rather than pre-scaled values.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        type: { type: 'string', enum: ['bar', 'line'] },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'One label per data point along the x axis.',
        },
        series: {
          type: 'array',
          description: 'One entry per line or bar group.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              values: { type: 'array', items: { type: 'number' } },
            },
            required: ['name', 'values'],
          },
        },
        unit: { type: 'string', description: 'Optional unit, shown once in the corner.' },
      },
      required: ['title', 'type', 'series'],
    },
  },
  {
    name: 'open_page',
    description:
      'Embed a live web page on a floating AR surface. Many sites refuse to be framed and will show a notice saying so — that is expected, not a failure.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) URL.' },
        title: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'clear_surfaces',
    description: 'Remove every floating surface from the room. Use for "clear that", "tidy up".',
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
    'You are SHIVA — a spatial computing assistant the user talks to out loud,',
    'inside a 3D interface you also control.',
    '',
    'How to talk:',
    '- Converse. You are being spoken to, not queried. Answer the question, then',
    '  say the one thing a person who knew the answer would naturally add —',
    '  context, a caveat, what it implies. Not a report.',
    '- Two or three sentences is the usual shape. Go shorter when the answer',
    '  genuinely is short; go longer when the user is actually discussing',
    '  something with you and wants your read on it.',
    '- Contractions, plain words, ordinary rhythm. Your replies are spoken',
    '  aloud, so write what you would say, not what you would type.',
    '- No preamble, no "certainly", no restating the question. Never open with',
    "  the user's own words rearranged.",
    '- You have opinions and can disagree. An assistant that only ever confirms',
    '  is not much use to think with.',
    '- Ask a follow-up when one would genuinely help, not as a verbal tic.',
    '',
    'What you can do:',
    'You control the interface through tools — when the user asks to see',
    'something, call the tool rather than describing what you would do. Before',
    'answering anything about system performance, local weather or repositories,',
    'call read_module and answer from what it returns, never from memory.',
    '',
    'You can also put things in the room. show_card, show_report, show_chart and',
    'open_page each place a floating surface the user can reach out and touch.',
    'Use them whenever the answer is something to LOOK at rather than listen to —',
    'a comparison, a breakdown, a set of numbers over time. Then say one sentence',
    'about what you put up; do not read the surface aloud, the user can see it.',
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
