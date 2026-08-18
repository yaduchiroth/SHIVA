'use client'

import { useEffect, useState } from 'react'
import { MODULES, getModule } from '@/core/config/modules'
import { useSystemStore } from '@/core/store/useSystemStore'
import { useGestureStore } from '@/core/store/useGestureStore'
import { useSpatialStore, activeModuleIndex } from '@/core/store/useSpatialStore'
import type { TrackingStatus } from '@/core/types'
import { useOdinStore } from '@/core/store/useOdinStore'
import type { LinkStatus } from '@/adapters/odin/client'

/**
 * The heads-up display.
 *
 * Rules this follows, which are what keep it reading as instrumentation rather
 * than decoration:
 *   - Every value shown is real. Nothing is padded with fake readouts.
 *   - It never intercepts pointer events except on genuinely interactive
 *     controls, so the 3D scene underneath stays fully reachable.
 *   - Text is small, tightly tracked and monospaced: density implies precision.
 */

function useClock(): string {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    // Deliberately not initialised during render: the server and client would
    // format different times and hydration would mismatch.
    setNow(new Date())
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  if (!now) return '--:--:--'
  return now.toLocaleTimeString('en-GB', { hour12: false })
}

const STATUS_COPY: Record<TrackingStatus, string> = {
  idle: 'Standby',
  requesting: 'Awaiting permission',
  loading: 'Loading model',
  active: 'Tracking',
  denied: 'Denied — pointer active',
  unavailable: 'Unavailable — pointer active',
}

const STATUS_COLOR: Record<TrackingStatus, string> = {
  idle: 'var(--color-ash)',
  requesting: 'var(--color-caution)',
  loading: 'var(--color-caution)',
  active: 'var(--color-nominal)',
  denied: 'var(--color-smoke)',
  unavailable: 'var(--color-smoke)',
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 tabular-nums">
      <span className="text-hud-label">{label}</span>
      <span style={{ color: tone ?? 'var(--color-mist)' }}>{value}</span>
    </div>
  )
}

/**
 * What the link row says, per status.
 *
 * "Blocked" is its own word rather than an error because it is not one: a
 * secure page cannot open an insecure socket, Odin may be running perfectly,
 * and calling it offline would send someone to restart a healthy process.
 */
const ODIN_COPY: Record<LinkStatus['status'], string> = {
  off: 'Off',
  connecting: 'Linking…',
  live: 'Linked',
  unreachable: 'Not running',
  blocked: 'Blocked (HTTPS)',
}

const ODIN_TONE: Record<LinkStatus['status'], string | undefined> = {
  off: undefined,
  connecting: 'var(--color-caution)',
  live: 'var(--color-nominal)',
  unreachable: 'var(--color-smoke)',
  blocked: 'var(--color-caution)',
}

export function Hud({ onEnableTracking }: { onEnableTracking: () => void }) {
  const odinLink = useOdinStore((s) => s.link)
  const companionCount = useOdinStore((s) => s.companions.length)
  const working = useOdinStore((s) => s.companions.filter((c) => c.state === 'working').length)
  const clock = useClock()
  const fps = useSystemStore((s) => s.fps)
  const frameMs = useSystemStore((s) => s.frameMs)
  const tier = useSystemStore((s) => s.tier)
  const baseTier = useSystemStore((s) => s.baseTier)
  const telemetry = useSystemStore((s) => s.telemetry)
  const telemetryError = useSystemStore((s) => s.telemetryError)

  const status = useGestureStore((s) => s.status)
  const reason = useGestureStore((s) => s.reason)
  const handsVisible = useGestureStore((s) => s.handsVisible)
  const inferenceMs = useGestureStore((s) => s.inferenceMs)
  const leftGesture = useGestureStore((s) => s.leftGesture)
  const rightGesture = useGestureStore((s) => s.rightGesture)
  const inputMode = useGestureStore((s) => s.inputMode)

  const index = useSpatialStore((s) => s.index)
  const focused = useSpatialStore((s) => s.focused)
  const active = getModule(activeModuleIndex(index))

  const canEnable = status === 'idle' || status === 'denied'

  return (
    <div className="hud-layer">
      {/* ── System, top-left ─────────────────────────────────────────────── */}
      <div className="hud-cluster top-6 left-6 w-56" data-testid="hud-status">
        <div className="flex items-center gap-2">
          <span
            className="inline-block size-1.5 rounded-full"
            style={{ background: 'var(--color-nominal)' }}
          />
          <span style={{ color: 'var(--color-bone)' }}>SHIVA</span>
          <span className="text-hud-label">v0.1</span>
        </div>
        <div className="hud-rule" />
        <Row label="Render" value={`${fps} fps · ${frameMs.toFixed(1)} ms`} />
        {/* A moved tier is shown as moved. "LOW" alone cannot distinguish a
            weak machine from one the governor demoted, and those need opposite
            responses — the second is a bug, the first is not. */}
        <Row
          label="Quality"
          value={
            tier === baseTier
              ? tier.toUpperCase()
              : `${tier.toUpperCase()} \u2193 ${baseTier.toUpperCase()}`
          }
        />
        <Row label="Input" value={inputMode === 'hand' ? 'Hand' : 'Pointer'} />
        <Row
          label="Module"
          value={active.code}
          tone={focused !== null ? 'var(--color-signal)' : undefined}
        />
        {/* Only shown once the link has been attempted. On a hosted page it
            never is, and a permanent "ODIN — OFF" would read as a fault rather
            than as a deployment that was never meant to reach a laptop. */}
        {odinLink.status !== 'off' ? (
          <Row label="Odin" value={ODIN_COPY[odinLink.status]} tone={ODIN_TONE[odinLink.status]} />
        ) : null}
        {companionCount > 0 ? (
          <Row
            label="Council"
            value={working > 0 ? `${companionCount} · ${working} out` : String(companionCount)}
            tone={working > 0 ? 'var(--color-caution)' : undefined}
          />
        ) : null}
      </div>

      {/* ── Clock + conditions, top-right ────────────────────────────────── */}
      <div className="hud-cluster top-6 right-6 items-end" data-testid="hud-clock">
        <span
          className="text-2xl tabular-nums"
          style={{ color: 'var(--color-bone)', letterSpacing: '0.06em' }}
        >
          {clock}
        </span>
        <div className="hud-rule w-32 self-end" />
        {telemetry ? (
          <>
            <span>
              {telemetry.temperatureC}°C · {telemetry.condition}
            </span>
            <span className="text-hud-label">{telemetry.location}</span>
          </>
        ) : (
          // Says what's actually true rather than showing a placeholder reading.
          <span className="text-hud-label" title={telemetryError ?? undefined}>
            {telemetryError ? 'Conditions unavailable' : 'Acquiring conditions'}
          </span>
        )}
      </div>

      {/* ── Module index, bottom-left ────────────────────────────────────── */}
      <div className="hud-cluster bottom-6 left-6" data-testid="active-module">
        <span className="text-hud-label">Active</span>
        <span className="text-base" style={{ color: 'var(--color-bone)' }}>
          {active.label.toUpperCase()}
        </span>
        <div className="mt-1 flex gap-1">
          {MODULES.map((m, i) => (
            <span
              key={m.id}
              className="h-0.5 w-6 transition-all duration-300"
              style={{
                background:
                  i === activeModuleIndex(index) ? 'var(--color-signal)' : 'var(--color-steel)',
              }}
            />
          ))}
        </div>
      </div>

      {/* ── Tracking, bottom-right ───────────────────────────────────────── */}
      <div className="hud-cluster right-6 bottom-6 w-60 items-end" data-testid="hud-tracking">
        <div className="flex items-center gap-2">
          <span className="text-hud-label">Tracking</span>
          <span
            className="inline-block size-1.5 rounded-full"
            style={{ background: STATUS_COLOR[status] }}
          />
        </div>
        <div className="hud-rule w-full" />
        <Row label="State" value={STATUS_COPY[status]} tone={STATUS_COLOR[status]} />
        {status === 'active' && (
          <>
            <Row label="Hands" value={String(handsVisible)} />
            <Row label="Inference" value={`${inferenceMs.toFixed(1)} ms`} />
            <Row label="L / R" value={`${leftGesture} / ${rightGesture}`} />
          </>
        )}
        {canEnable && (
          <button
            type="button"
            onClick={onEnableTracking}
            // The HUD layer is pointer-transparent by default; re-enabled here
            // only, so the button works without blocking the scene behind it.
            className="glass-surface mt-2 cursor-pointer px-3 py-1.5 transition-colors"
            style={{ pointerEvents: 'auto', color: 'var(--color-mist)' }}
          >
            Enable hand tracking
          </button>
        )}
        {reason && <span className="text-hud-label mt-1 text-right normal-case">{reason}</span>}
      </div>

      {/* ── Gesture legend, bottom-centre ────────────────────────────────── */}
      <div
        className="hud-cluster bottom-6 left-1/2 -translate-x-1/2 flex-row gap-5"
        style={{ color: 'var(--color-ash)' }}
      >
        {inputMode === 'hand' ? (
          <>
            <span>Swipe · rotate</span>
            <span>Pinch · grab</span>
            <span>Fist · expand</span>
            <span>Palm · dismiss</span>
          </>
        ) : (
          <>
            <span>Drag · rotate</span>
            <span>Hold · grab</span>
            <span>Click · expand</span>
            <span>Esc · dismiss</span>
          </>
        )}
      </div>
    </div>
  )
}
