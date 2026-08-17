import { expect, test } from '@playwright/test'
import { HandRecognizer } from '@/spatial/hands/gestureRecognizer'
import { clearBus, on } from '@/core/events/bus'
import type { EventMap } from '@/core/events/bus'
import type { HandState } from '@/core/types'
import { extractWakeCommand } from '@/brain/speech'
import { TOOLS, buildSystemPrompt } from '@/adapters/brain/commands'
import { handPose } from './handPose'

function emptyHand(): HandState {
  return {
    visible: false,
    handedness: 'right',
    position: { x: 0, y: 0, z: 0 },
    tip: { x: 0, y: 0, z: 0 },
    pinch: 0,
    grab: 0,
    openness: 0,
    gesture: 'idle',
    velocity: { x: 0, y: 0, z: 0 },
    timestamp: 0,
    landmarks: Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 })),
  }
}

test.describe('wake phrase', () => {
  test('extracts the command that follows it', () => {
    expect(extractWakeCommand('shiva show me the markets')).toBe('show me the markets')
    expect(extractWakeCommand('Hey SHIVA, what is the weather?')).toBe('what is the weather?')
    // Punctuation between the wake word and the command must not survive into
    // the prompt.
    expect(extractWakeCommand('Shiva: rotate left')).toBe('rotate left')
  })

  test('tolerates how speech engines actually transcribe it', () => {
    // These are real variants speech recognition produces for the same spoken
    // word. Accepting only one spelling makes the feature work for some accents
    // and silently fail for others.
    for (const variant of ['shiva', 'sheva', 'siva', 'shivah']) {
      expect(extractWakeCommand(`${variant} dismiss`), variant).toBe('dismiss')
    }
  })

  test('returns null when not addressed', () => {
    expect(extractWakeCommand('what is the weather today')).toBeNull()
    // Substring matches must not count — otherwise ordinary words wake it.
    expect(extractWakeCommand('the shivering cold outside')).toBeNull()
  })

  test('distinguishes a bare wake from a wake with a command', () => {
    // '' means "woken, awaiting instruction"; null means "not addressed". The
    // UI treats these completely differently, so conflating them would either
    // send empty prompts or ignore the wake word entirely.
    expect(extractWakeCommand('shiva')).toBe('')
    expect(extractWakeCommand('nothing relevant')).toBeNull()
  })
})

test.describe('circle wake gesture', () => {
  test.beforeEach(() => clearBus())

  /** Traces a circle with a pointing hand. */
  function traceCircle(turns: number, samples = 30) {
    const recognizer = new HandRecognizer('right')
    const out = emptyHand()
    for (let i = 0; i < samples; i++) {
      const angle = (i / samples) * Math.PI * 2 * turns
      recognizer.update(
        handPose({
          fingers: [0, 1, 1, 1],
          thumb: 0.8,
          origin: { x: 0.5 + Math.cos(angle) * 0.09, y: 0.6 + Math.sin(angle) * 0.09 },
        }),
        i / 30,
        out,
      )
    }
  }

  test('a traced circle wakes the brain', () => {
    const wakes: EventMap['brain:wake'][] = []
    on('brain:wake', (e) => wakes.push(e))
    traceCircle(1)
    expect(wakes.length).toBe(1)
  })

  test('a back-and-forth wave does not', () => {
    // The reason the detector sums SIGNED angle: a wave sweeps a large total
    // angle but nets to roughly zero. Summing absolute angle would fire here.
    const wakes: EventMap['brain:wake'][] = []
    on('brain:wake', (e) => wakes.push(e))

    const recognizer = new HandRecognizer('right')
    const out = emptyHand()
    for (let i = 0; i < 40; i++) {
      recognizer.update(
        handPose({
          fingers: [0, 1, 1, 1],
          thumb: 0.8,
          origin: { x: 0.5 + Math.sin(i * 0.6) * 0.12, y: 0.6 },
        }),
        i / 30,
        out,
      )
    }
    expect(wakes.length).toBe(0)
  })

  test('an open hand circling does not wake', () => {
    // Circle tracking is gated on pointing, so ordinary hand movement can't
    // accumulate into a false wake.
    const wakes: EventMap['brain:wake'][] = []
    on('brain:wake', (e) => wakes.push(e))

    const recognizer = new HandRecognizer('right')
    const out = emptyHand()
    for (let i = 0; i < 30; i++) {
      const angle = (i / 30) * Math.PI * 2
      recognizer.update(
        handPose({ origin: { x: 0.5 + Math.cos(angle) * 0.09, y: 0.6 + Math.sin(angle) * 0.09 } }),
        i / 30,
        out,
      )
    }
    expect(wakes.length).toBe(0)
  })

  test('a single continuous circle wakes once, not once per frame', () => {
    const wakes: EventMap['brain:wake'][] = []
    on('brain:wake', (e) => wakes.push(e))
    traceCircle(2, 60)
    expect(wakes.length, 'the cooldown must suppress repeats within one motion').toBe(1)
  })
})

test.describe('command engine', () => {
  test('every tool has a schema the model can call', () => {
    for (const tool of TOOLS) {
      expect(tool.name, 'tool needs a name').toBeTruthy()
      // Gemini rejects a function declaration whose description is missing, and
      // an under-described tool simply never gets chosen.
      expect(tool.description.length, `${tool.name} needs a real description`).toBeGreaterThan(20)
      expect(tool.parameters.type).toBe('object')
    }
  })

  test('the system prompt forbids inventing data for unconnected modules', () => {
    const prompt = buildSystemPrompt({ activeModule: 'system' })

    // The single most damaging failure for an assistant like this is a
    // confident fabricated number, so the instruction against it must survive
    // any future prompt edit.
    expect(prompt).toMatch(/not connected/i)
    expect(prompt).toMatch(/markets/)
    // And it must state what IS live, or the model hedges on everything.
    expect(prompt).toMatch(/weather/)
  })

  test('the prompt carries live context when telemetry has it', () => {
    const withData = buildSystemPrompt({
      activeModule: 'weather',
      temperatureC: 21,
      condition: 'Overcast',
      location: 'Asia/Kolkata',
    })
    expect(withData).toContain('21°C')
    expect(withData).toContain('Overcast')

    const without = buildSystemPrompt({ activeModule: 'weather' })
    expect(without).toMatch(/unavailable/i)
  })
})
