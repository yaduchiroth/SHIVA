'use client'

import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import type { QualitySettings } from '@/core/config/quality'
import { PALETTE } from '@/core/config/palette'
import { useBrainStore } from '@/core/store/useBrainStore'
import { on } from '@/core/events/bus'
import { damp } from '@/lib/math'
import type { Rgb } from './geometry'
import { Companions } from './Companions'
import { GlyphField } from './GlyphField'
import { NeuralNet } from './NeuralNet'
import { OrbCore } from './OrbCore'
import { ProtonCloud } from './ProtonCloud'
import { Shell } from './Shell'
import { PHASE_DRIVE, firePulse, firePulseAt, orbDrive, resetOrbDrive } from './orbDrive'

/**
 * SHIVA's face.
 *
 * Five layers, each one draw call or close to it, all sharing a single clock
 * and a single mood. The layers know nothing about each other or about React —
 * they read `orbDrive`, which this component is the only writer of.
 *
 * Radii are chosen against the scene it sits in, not in isolation. The carousel
 * ring is at 4.6 and the camera at 11.5, so the shell at 2.0 fills roughly half
 * the frame height and the proton cloud stops at 3.8 — far enough out to have
 * depth, close enough in that particles never drift through a panel face.
 */

const SHELL_RADIUS = 2.0
const NEURON_INNER = 0.75
const NEURON_OUTER = 1.75
const GLYPH_INNER = 1.05
const GLYPH_OUTER = 2.2
const PROTON_INNER = 2.4
const PROTON_OUTER = 3.8

/** One seed for the whole orb, so the object is the same on every load. */
const SEED = 0x5417a

interface Props {
  quality: QualitySettings
  reducedMotion: boolean
}

export function Orb({ quality, reducedMotion }: Props) {
  const phase = useBrainStore((s) => s.phase)

  const palette = useMemo(() => {
    const rgb = (hex: string): Rgb => {
      const n = parseInt(hex.slice(1), 16)
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
    }
    return {
      bright: rgb(PALETTE.signal),
      mid: rgb(PALETTE['signal-dim']),
      faint: rgb(PALETTE.steel),
      hot: rgb(PALETTE.bone),
      warm: rgb(PALETTE.tracking),
    }
  }, [])

  // Phase lives in the store because the HUD renders it; the orb needs it as a
  // number it can damp toward, which is what `orbDrive` is for.
  useEffect(() => {
    orbDrive.phase = phase
  }, [phase])

  useEffect(() => {
    // Discrete events become pulses. Position matters: a pinch should light the
    // network where the hand is, not at the centre, or the orb feels like it is
    // reacting to something else entirely.
    const offs = [
      on('gesture:start', ({ position }) => {
        // Hand position is normalised video space with the origin top-left, so
        // y is inverted relative to world space.
        const theta = (position.x - 0.5) * Math.PI * 2
        const phi = Math.PI * (1 - position.y)
        firePulse(
          NEURON_OUTER * Math.sin(phi) * Math.cos(theta),
          NEURON_OUTER * Math.cos(phi),
          NEURON_OUTER * Math.sin(phi) * Math.sin(theta),
        )
      }),
      on('brain:wake', () => {
        orbDrive.surge = 1
        firePulse(0, 0, 0)
      }),
      on('carousel:step', () => firePulseAt(NEURON_OUTER)),
      on('ui:confirm', ({ intensity }) => {
        orbDrive.surge = Math.max(orbDrive.surge, intensity * 0.5)
        firePulseAt(NEURON_INNER)
      }),
      on('tracking:acquired', () => firePulse(0, 0, 0)),
    ]
    return () => {
      for (const off of offs) off()
      resetOrbDrive()
    }
  }, [])

  useFrame((_, dt) => {
    // Clamped for the same reason the shell's rotation is: a backgrounded tab
    // resumes with one enormous delta, and an unclamped `damp` over it snaps
    // every value straight to target, which looks like a glitch on return.
    const step = Math.min(dt, 0.05)
    orbDrive.time += reducedMotion ? step * 0.25 : step

    const target = PHASE_DRIVE[orbDrive.phase] ?? PHASE_DRIVE.idle
    // Colour damps faster than energy: a state change should be legible
    // immediately, while the liveliness behind it settles in over a second or
    // so. Equal rates make the whole thing feel like one slow switch.
    for (let i = 0; i < 3; i++) {
      orbDrive.accent[i] = damp(orbDrive.accent[i]!, target[i]!, 4.5, step)
    }
    orbDrive.energy = damp(orbDrive.energy, target[3]!, 2.2, step)
  })

  return (
    <group>
      <Shell
        radius={SHELL_RADIUS}
        rings={quality.orb.shellRings}
        meridians={quality.orb.shellMeridians}
        bright={palette.bright}
        mid={palette.mid}
        faint={palette.faint}
        seed={SEED}
        reducedMotion={reducedMotion}
      />
      <NeuralNet
        budget={quality.orb}
        innerRadius={NEURON_INNER}
        outerRadius={NEURON_OUTER}
        seed={SEED + 1}
      />
      <GlyphField
        budget={quality.orb}
        innerRadius={GLYPH_INNER}
        outerRadius={GLYPH_OUTER}
        seed={SEED + 2}
      />
      <ProtonCloud
        budget={quality.orb}
        minRadius={PROTON_INNER}
        maxRadius={PROTON_OUTER}
        hot={palette.hot}
        warm={palette.warm}
        seed={SEED + 3}
      />
      <OrbCore reducedMotion={reducedMotion} />
      {/* Odin's roster, when it is linked. Renders nothing otherwise. */}
      <Companions />
    </group>
  )
}
