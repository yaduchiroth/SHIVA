'use client'

import { useEffect, useRef } from 'react'
import { on } from '@/core/events/bus'
import { useSpatialStore } from '@/core/store/useSpatialStore'
import { AudioEngine } from './engine'

/**
 * Binds the audio engine to interaction.
 *
 * Autoplay policy means the context can't start until the user has interacted,
 * so rather than prompting for permission to make noise — which nobody grants —
 * the engine arms itself on the first real interaction of any kind. That
 * interaction is almost always the one that also triggers a confirmation sound,
 * so the audio arrives exactly when the user did something.
 */
export function useAudioEngine() {
  const engine = useRef<AudioEngine | null>(null)
  const setAudioEnabled = useSpatialStore((s) => s.setAudioEnabled)

  useEffect(() => {
    const instance = new AudioEngine()
    engine.current = instance

    const arm = async () => {
      const ok = await instance.start()
      setAudioEnabled(ok)
      if (ok) removeArmListeners()
    }

    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart']
    const removeArmListeners = () => {
      events.forEach((e) => window.removeEventListener(e, arm))
    }
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }))

    const offConfirm = on('ui:confirm', ({ intensity }) => instance.confirm(intensity))
    const offFocus = on('panel:focus', () => instance.duck(1))
    const offBlur = on('panel:blur', () => instance.duck(0))

    // Silence when the tab is hidden. Background audio from a page nobody is
    // looking at is the fastest way to get muted permanently.
    const onVisibility = () => instance.setEnabled(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      removeArmListeners()
      offConfirm()
      offFocus()
      offBlur()
      document.removeEventListener('visibilitychange', onVisibility)
      instance.dispose()
      engine.current = null
    }
  }, [setAudioEnabled])

  return engine
}
