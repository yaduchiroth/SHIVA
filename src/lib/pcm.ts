/**
 * PCM conversion for the voice agent.
 *
 * Deepgram speaks raw `linear16` — signed 16-bit little-endian samples — in both
 * directions. WebAudio speaks `Float32Array` in −1..1. Nothing converts between
 * them for you, and every mistake in that conversion produces audio rather than
 * an error: get the sign wrong and it's noise, get the scale wrong and it clips,
 * get the sample rate wrong and it plays at the wrong pitch while sounding
 * otherwise fine. So the conversions live here, alone, and are tested.
 *
 * The asymmetric scaling below is deliberate and is the part people get wrong:
 * int16 runs −32768..32767, which is not symmetric. Dividing by 32768 on the way
 * in and multiplying by 32767 on the way out keeps every value in range without
 * ever wrapping — multiplying by 32768 lets a sample at exactly 1.0 overflow to
 * −32768, which is a full-scale click in the middle of a word.
 */

/** Float32 (−1..1) → little-endian int16 bytes, ready to put on the wire. */
export function floatToInt16(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const sample = input[i] ?? 0
    // Clamp first: WebAudio can hand back values slightly outside −1..1 after
    // gain, and those wrap rather than saturate once truncated.
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return out.buffer
}

/** Little-endian int16 bytes → Float32 (−1..1), ready for an AudioBuffer. */
export function int16ToFloat(buffer: ArrayBuffer): Float32Array<ArrayBuffer> {
  // A truncated frame would make the Int16Array constructor throw on an odd
  // byte length; drop the stray byte instead of losing the whole frame.
  const usable = buffer.byteLength - (buffer.byteLength % 2)
  const samples = new Int16Array(buffer, 0, usable / 2)
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    out[i] = (samples[i] ?? 0) / 0x8000
  }
  return out
}

/**
 * Linear resampling to the rate the agent expects.
 *
 * Microphones are almost never at the rate you asked for — the browser hands
 * back whatever the device runs at, typically 48 kHz, and Chrome ignores a
 * `sampleRate` constraint on the AudioContext often enough that you cannot rely
 * on it. Sending 48 kHz audio labelled as 24 kHz makes the agent hear
 * everything at half speed, which it transcribes as gibberish rather than
 * failing, so this is not optional.
 *
 * Linear interpolation is the right trade here: speech is band-limited well
 * below the Nyquist frequency of either rate, this runs on every audio frame,
 * and a polyphase filter would cost far more than it improves transcription.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input

  const ratio = fromRate / toRate
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)

  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const index = Math.floor(position)
    const fraction = position - index
    const a = input[index] ?? 0
    // The final sample has no successor to interpolate toward; hold it.
    const b = input[index + 1] ?? a
    out[i] = a + (b - a) * fraction
  }

  return out
}
