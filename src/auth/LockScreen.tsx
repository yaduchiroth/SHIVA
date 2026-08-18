'use client'

import { useCallback, useEffect, useState } from 'react'
import { useOdinStore } from '@/core/store/useOdinStore'
import { emit } from '@/core/events/bus'
import { say } from '@/brain/speech'
import { isLockForced } from '@/lib/device'

/**
 * SHIVA recognising you, and letting you in.
 *
 * No new model and no second enrolment: the mind already does face recognition
 * with OpenCV, is already enrolled with your face, and already publishes
 * `presence {name, known}` on the bus. This waits for that event. Porting a
 * face pipeline into the browser would have meant ten megabytes of ONNX to
 * reach a conclusion the machine next to it had already reached.
 *
 * It is a greeting, not a vault. This runs on your own Mac, behind your own
 * login, and the honest consequence of that is the three ways out below — none
 * of them optional:
 *
 *   - **The mind is not running.** Nothing could ever recognise you, so
 *     waiting is not caution, it is a broken app. Opens immediately.
 *   - **The camera cannot start.** Same conclusion, reported by the mind as a
 *     log rather than a presence event, so the timeout below catches it.
 *   - **Fifteen seconds.** A Continue button appears regardless. Whatever has
 *     gone wrong, this must never be the reason you cannot reach your own
 *     interface.
 */

/** How long before the way out appears, whatever the mind is doing. */
export const ESCAPE_MS = 15_000

/** How long the greeting is held on screen before the interface arrives. */
export const GREETING_MS = 1400

/**
 * Remembered per tab, not per browser.
 *
 * A reload should not repeat the ceremony — you are demonstrably still there —
 * but a fresh tab should greet you again, because that is the part worth
 * having. `localStorage` would make the greeting a once-ever event.
 */
const STORAGE_KEY = 'shiva:unlocked'

type Stage = 'waiting' | 'greeting' | 'unknown' | 'open'

export function LockScreen() {
  const [stage, setStage] = useState<Stage>(() => {
    if (typeof window === 'undefined') return 'waiting'
    return window.sessionStorage.getItem(STORAGE_KEY) === '1' ? 'open' : 'waiting'
  })
  const [escapable, setEscapable] = useState(false)
  const link = useOdinStore((s) => s.link)
  const presence = useOdinStore((s) => s.presence)
  // `?lock=1` holds the ceremony open with no mind to drive it, so it can be
  // seen and tested on a machine that has none.
  const [forced] = useState(isLockForced)

  const unlock = useCallback(() => {
    setStage('open')
    if (typeof window !== 'undefined') window.sessionStorage.setItem(STORAGE_KEY, '1')
  }, [])

  // Nothing to wait for. `off` covers a page that never attempted the link at
  // all — which is every hosted deployment — and `unreachable` covers the mind
  // simply not being up.
  useEffect(() => {
    if (stage === 'open' || forced) return
    if (link.status === 'off' || link.status === 'unreachable' || link.status === 'blocked') {
      unlock()
    }
  }, [link.status, stage, unlock, forced])

  useEffect(() => {
    if (stage === 'open') return
    const timer = setTimeout(() => setEscapable(true), ESCAPE_MS)
    return () => clearTimeout(timer)
  }, [stage])

  useEffect(() => {
    if (stage === 'open' || !presence) return
    setStage(presence.known ? 'greeting' : 'unknown')
  }, [presence, stage])

  // The greeting is its own effect, keyed only on the stage it belongs to.
  //
  // Folded into the effect above it does not work, and the way it fails is
  // quiet: `setStage('greeting')` changes a dependency, React tears the effect
  // down, and the cleanup cancels the very timer that was about to open the
  // lock. The greeting appears and the interface never arrives.
  useEffect(() => {
    if (stage !== 'greeting') return
    emit('ui:confirm', { intensity: 1 })
    void say('Welcome back, boss.')
    // Held so the greeting is legible before the interface arrives — long
    // enough to read, short enough that it never feels like a wait.
    const timer = setTimeout(unlock, GREETING_MS)
    return () => clearTimeout(timer)
  }, [stage, unlock])

  if (stage === 'open') return null

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-end gap-3 pb-28"
      style={{
        // The orb stays visible behind it. Logging into something already alive
        // is the whole idea; a solid panel would hide the one thing worth
        // looking at while you wait.
        background: 'radial-gradient(ellipse at center, transparent 20%, var(--color-void) 88%)',
      }}
      data-testid="lock-screen"
      data-stage={stage}
    >
      <p className="text-sm tracking-[0.5em]" style={{ color: 'var(--color-bone)' }}>
        SHIVA
      </p>

      {stage === 'greeting' ? (
        <p
          className="text-[13px] tracking-[0.2em] uppercase"
          style={{ color: 'var(--color-nominal)' }}
          data-testid="lock-greeting"
        >
          Welcome back, {presence?.name ?? 'boss'}
        </p>
      ) : stage === 'unknown' ? (
        <p
          className="text-[13px] tracking-[0.2em] uppercase"
          style={{ color: 'var(--color-caution)' }}
        >
          I don&apos;t know you
        </p>
      ) : (
        <p className="text-[12px] tracking-[0.2em] text-[var(--color-smoke)] uppercase">
          Looking for you…
        </p>
      )}

      {escapable && stage !== 'greeting' && (
        <button
          type="button"
          onClick={unlock}
          className="glass-surface mt-4 cursor-pointer px-4 py-2 transition-colors"
          style={{ color: 'var(--color-mist)', pointerEvents: 'auto' }}
          data-testid="lock-continue"
        >
          <span className="text-hud-label">Continue</span>
        </button>
      )}
    </div>
  )
}
