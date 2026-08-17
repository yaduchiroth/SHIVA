import { expect, test } from '@playwright/test'
import { floatToInt16, int16ToFloat, resample } from '@/lib/pcm'

/**
 * PCM conversion.
 *
 * These are worth testing precisely because none of their failure modes produce
 * an error. A sign flip, an off-by-one in the scale, or a missed resample all
 * yield perfectly valid audio that is simply wrong — noise, a click, or speech
 * at the wrong speed. There is nothing to catch at runtime, so it gets caught
 * here or not at all.
 */

const int16 = (buffer: ArrayBuffer) => new Int16Array(buffer)

test.describe('floatToInt16', () => {
  test('maps the full range without wrapping', () => {
    const out = int16(floatToInt16(new Float32Array([0, 1, -1, 0.5, -0.5])))
    expect(out[0]).toBe(0)
    // The trap: scaling +1.0 by 32768 overflows to -32768, which is full-scale
    // NEGATIVE — a loud click in the middle of a word rather than a quiet bug.
    expect(out[1]).toBe(32767)
    expect(out[2]).toBe(-32768)
    expect(out[3]).toBeCloseTo(16383, -1)
    expect(out[4]).toBeCloseTo(-16384, -1)
  })

  test('clamps values outside the range instead of wrapping them', () => {
    // WebAudio can hand back slightly out-of-range samples after gain, and
    // truncation wraps rather than saturates.
    const out = int16(floatToInt16(new Float32Array([1.5, -1.5, 8])))
    expect(out[0]).toBe(32767)
    expect(out[1]).toBe(-32768)
    expect(out[2]).toBe(32767)
  })

  test('emits two bytes per sample', () => {
    expect(floatToInt16(new Float32Array(160)).byteLength).toBe(320)
  })
})

test.describe('int16ToFloat', () => {
  test('inverts floatToInt16 within quantisation error', () => {
    const source = new Float32Array([0, 0.25, -0.25, 0.75, -0.75])
    const round = int16ToFloat(floatToInt16(source))
    for (let i = 0; i < source.length; i++) {
      // One int16 step is ~3e-5; anything larger means a scaling mistake.
      expect(round[i]!).toBeCloseTo(source[i]!, 4)
    }
  })

  test('survives a frame truncated mid-sample', () => {
    // A websocket frame can arrive with an odd byte count. Constructing an
    // Int16Array over it throws, which would drop the whole frame rather than
    // one stray byte.
    const odd = new ArrayBuffer(5)
    expect(int16ToFloat(odd)).toHaveLength(2)
  })

  test('handles an empty frame', () => {
    expect(int16ToFloat(new ArrayBuffer(0))).toHaveLength(0)
  })
})

test.describe('resample', () => {
  test('is a no-op at matching rates', () => {
    const input = new Float32Array([1, 2, 3])
    // Returned by identity, not copied — this runs on every audio frame.
    expect(resample(input, 24000, 24000)).toBe(input)
  })

  test('halves the sample count from 48k to 24k', () => {
    // The case that matters: browsers routinely ignore the requested context
    // rate and hand back 48 kHz. Sending that unresampled makes the agent hear
    // everything at half speed and transcribe gibberish — with no error.
    expect(resample(new Float32Array(960), 48000, 24000)).toHaveLength(480)
  })

  test('handles a non-integer ratio', () => {
    expect(resample(new Float32Array(441), 44100, 24000)).toHaveLength(240)
  })

  test('preserves the shape of a ramp', () => {
    const input = new Float32Array(100)
    for (let i = 0; i < input.length; i++) input[i] = i / 100
    const out = resample(input, 48000, 24000)

    expect(out[0]).toBeCloseTo(0, 5)
    // Interpolated, so it tracks the original ramp at the same position in time.
    expect(out[25]).toBeCloseTo(0.5, 2)
    expect(out.at(-1)!).toBeCloseTo(0.98, 2)
  })

  test('upsamples as well as down', () => {
    expect(resample(new Float32Array(240), 24000, 48000)).toHaveLength(480)
  })

  test('handles an empty buffer', () => {
    expect(resample(new Float32Array(0), 48000, 24000)).toHaveLength(0)
  })
})
