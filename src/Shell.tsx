'use client'

import { useCallback, useEffect, useState } from 'react'
import { Stage } from '@/spatial/Stage'
import { Hud } from '@/hud/Hud'
import { BootSequence } from '@/hud/BootSequence'
import { useLiveData } from '@/data/useLiveData'
import { useHandTracking } from '@/spatial/hands/useHandTracking'
import { useInteractionDriver, usePointerFallback } from '@/spatial/hands/useInteractionDriver'
import { useAudioEngine } from '@/audio/useAudioEngine'
import { useSystemStore } from '@/core/store/useSystemStore'
import { getDeviceProfile, isHandDebugEnabled, isSurfaceDemoEnabled } from '@/lib/device'
import { HandDebugOverlay } from '@/hud/HandDebugOverlay'
import { BrainConsole } from '@/hud/BrainConsole'
import { seedDemoSurfaces } from '@/core/store/useSurfaceStore'
import { installDevHooks, isDevHooksEnabled } from '@/lib/devHooks'
import { useOdinLink } from '@/adapters/odin/useOdinLink'

/**
 * Top-level composition.
 *
 * Everything that isn't rendering lives here: input, audio, telemetry and boot.
 * Keeping them out of the R3F tree means none of them can accidentally
 * re-render the scene, and each stays independently testable.
 */
export function Shell() {
  const [webglFailed, setWebglFailed] = useState(false)
  const [handDebug] = useState(isHandDebugEnabled)
  const boot = useSystemStore((s) => s.boot)
  const setBoot = useSystemStore((s) => s.setBoot)

  const { start: startTracking } = useHandTracking()

  // Drives every live source: fetched (weather, projects) and measured (system).
  useLiveData()
  useInteractionDriver()
  // Pointer control stays live until hand tracking takes over; the hook itself
  // stands down when input mode flips.
  usePointerFallback(true)
  useAudioEngine()
  // Links to Odin when it is reachable; a no-op on a hosted page, where the
  // browser will not open an insecure socket from a secure origin.
  useOdinLink()

  useEffect(() => {
    setBoot('booting')
    if (!getDeviceProfile().supportsWebGL2) setWebglFailed(true)
    if (isSurfaceDemoEnabled()) seedDemoSurfaces()
    if (isDevHooksEnabled()) installDevHooks()
  }, [setBoot])

  const handleBootComplete = useCallback(() => setBoot('ready'), [setBoot])

  if (webglFailed) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-2xl" style={{ color: 'var(--color-bone)', letterSpacing: '0.4em' }}>
          SHIVA
        </h1>
        <p style={{ color: 'var(--color-smoke)', maxWidth: '32rem' }}>
          This device has no available WebGL context, so the spatial interface cannot start. Try a
          different browser, or enable hardware acceleration in your browser settings.
        </p>
      </main>
    )
  }

  return (
    <main className="relative h-full w-full">
      <Stage />
      <Hud onEnableTracking={startTracking} />
      {handDebug && <HandDebugOverlay />}
      <BrainConsole />
      <BootSequence onComplete={handleBootComplete} />
      {/* Test anchor: marks the point at which the OS is interactive. */}
      {boot === 'ready' && <div data-testid="os-ready" hidden />}
    </main>
  )
}
