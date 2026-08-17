/**
 * Procedural audio.
 *
 * Every sound here is synthesised at runtime. No audio files ship with SHIVA,
 * which means nothing to license, nothing to download, and no bundle cost — and
 * synthesis suits the aesthetic better than samples anyway: the confirmation
 * blip can be pitched from the same interval as the ambient drone, so the whole
 * interface stays in one key instead of sounding like assembled stock effects.
 *
 * Everything routes through a master gain that starts silent and is only lifted
 * after a user gesture, because browsers suspend `AudioContext` until then.
 */

const ROOT_HZ = 55 // A1 — the fundamental everything is tuned against.

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private ambientGain: GainNode | null = null
  private voices: OscillatorNode[] = []
  private noiseSource: AudioBufferSourceNode | null = null
  private started = false
  private disposed = false

  get running(): boolean {
    return this.started && this.ctx?.state === 'running'
  }

  /** Must be called from a user-gesture handler or the context stays suspended. */
  async start(): Promise<boolean> {
    if (this.disposed) return false
    if (this.started) {
      // Browsers re-suspend on tab hide; resuming is cheap and idempotent.
      if (this.ctx?.state === 'suspended') await this.ctx.resume()
      return this.running
    }

    try {
      const Ctor =
        window.AudioContext ??
        (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return false

      const ctx = new Ctor()
      if (ctx.state === 'suspended') await ctx.resume()

      this.ctx = ctx
      this.master = ctx.createGain()
      this.master.gain.value = 0
      this.master.connect(ctx.destination)

      this.buildAmbient()
      this.started = true

      // Fade in over several seconds — an ambient bed that arrives abruptly is
      // startling and immediately reads as "turn this off".
      this.master.gain.setTargetAtTime(0.18, ctx.currentTime, 2.5)
      return true
    } catch {
      return false
    }
  }

  private buildAmbient(): void {
    const ctx = this.ctx
    if (!ctx || !this.master) return

    const ambient = ctx.createGain()
    ambient.gain.value = 0.5
    ambient.connect(this.master)
    this.ambientGain = ambient

    // ── Drone ────────────────────────────────────────────────────────────────
    // A root and its fifth, each doubled with a slight detune. The beating
    // between detuned pairs is what stops a sustained tone sounding synthetic
    // and dead.
    const intervals = [1, 1.5, 2, 3]
    const detunes = [-7, 5, -3, 4]

    intervals.forEach((ratio, i) => {
      const osc = ctx.createOscillator()
      osc.type = i < 2 ? 'sine' : 'triangle'
      osc.frequency.value = ROOT_HZ * ratio
      osc.detune.value = detunes[i] ?? 0

      const gain = ctx.createGain()
      // Upper partials sit far back — presence without pitch becoming a melody.
      gain.gain.value = i === 0 ? 0.5 : 0.16 / i

      // A slow LFO on each voice's gain, at prime-ish rates so the pattern
      // never audibly repeats.
      const lfo = ctx.createOscillator()
      lfo.frequency.value = 0.03 + i * 0.017
      const lfoGain = ctx.createGain()
      lfoGain.gain.value = gain.gain.value * 0.6
      lfo.connect(lfoGain).connect(gain.gain)
      lfo.start()

      osc.connect(gain).connect(ambient)
      osc.start()
      this.voices.push(osc, lfo)
    })

    // ── Air ──────────────────────────────────────────────────────────────────
    // Heavily filtered noise: the room tone that makes the drone sound like it
    // exists in a space rather than in a vacuum.
    const duration = 4
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    let last = 0
    for (let i = 0; i < data.length; i++) {
      // One-pole low-pass over white noise gives brown-ish noise, which is far
      // less fatiguing than white over long listening.
      const white = Math.random() * 2 - 1
      last = (last + 0.02 * white) / 1.02
      data[i] = last * 3.5
    }

    const noise = ctx.createBufferSource()
    noise.buffer = buffer
    noise.loop = true

    const noiseFilter = ctx.createBiquadFilter()
    noiseFilter.type = 'bandpass'
    noiseFilter.frequency.value = 420
    noiseFilter.Q.value = 0.6

    const noiseGain = ctx.createGain()
    noiseGain.gain.value = 0.09

    noise.connect(noiseFilter).connect(noiseGain).connect(ambient)
    noise.start()
    this.noiseSource = noise
  }

  /**
   * A confirmation transient.
   *
   * Pitched to a harmonic of the drone so it lands in key, and shaped with a
   * fast attack and short decay so it reads as a mechanical click rather than a
   * musical note.
   */
  confirm(intensity = 0.5): void {
    const ctx = this.ctx
    if (!ctx || !this.master || !this.running) return

    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    // Two octaves and a fifth above root — bright enough to cut through the bed.
    osc.frequency.setValueAtTime(ROOT_HZ * 12, now)
    osc.frequency.exponentialRampToValueAtTime(ROOT_HZ * 8, now + 0.09)

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.05 + intensity * 0.09, now + 0.006)
    // Exponential decay to near-zero, never to exactly zero — the Web Audio
    // exponential ramp is undefined at 0 and silently does nothing.
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16 + intensity * 0.1)

    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 300

    osc.connect(filter).connect(gain).connect(this.master)
    osc.start(now)
    osc.stop(now + 0.4)
    // Let the node graph be collected once it's finished sounding.
    osc.onended = () => {
      osc.disconnect()
      gain.disconnect()
      filter.disconnect()
    }
  }

  /** Lower the ambient bed without stopping it — used while a panel is focused. */
  duck(amount: number): void {
    if (!this.ctx || !this.ambientGain) return
    this.ambientGain.gain.setTargetAtTime(0.5 * (1 - amount * 0.6), this.ctx.currentTime, 0.4)
  }

  setEnabled(enabled: boolean): void {
    if (!this.ctx || !this.master) return
    this.master.gain.setTargetAtTime(enabled ? 0.18 : 0, this.ctx.currentTime, 0.3)
  }

  dispose(): void {
    this.disposed = true
    this.voices.forEach((v) => {
      try {
        v.stop()
        v.disconnect()
      } catch {
        // Already stopped — nothing to clean up.
      }
    })
    this.voices = []
    try {
      this.noiseSource?.stop()
      this.noiseSource?.disconnect()
    } catch {
      // Same.
    }
    this.noiseSource = null
    void this.ctx?.close()
    this.ctx = null
    this.master = null
    this.ambientGain = null
    this.started = false
  }
}
