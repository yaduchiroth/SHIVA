'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * A live page, embedded.
 *
 * Expect this to fail often, and say so when it does. Three separate mechanisms
 * refuse embedding and none of them report an error the parent can catch:
 *
 *   - `X-Frame-Options: DENY` / `SAMEORIGIN`, which most large sites send;
 *   - CSP `frame-ancestors`, which is the modern form of the same thing;
 *   - this app's own `Cross-Origin-Embedder-Policy: credentialless`, which
 *     strips credentials from the subresource load — so a page that embeds
 *     fine elsewhere may render logged out here, or not at all.
 *
 * In every case the iframe stays blank and `onLoad` may or may not fire. A
 * blank rectangle reads as a broken app, so after a grace period the surface
 * states plainly that the site refused and offers the URL — which is the one
 * thing the user can still act on.
 */

/** How long to wait before concluding nothing is coming. */
const REFUSAL_MS = 4000

export function WebFrame({ url, title }: { url: string; title: string }) {
  const [loaded, setLoaded] = useState(false)
  const [refused, setRefused] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    setLoaded(false)
    setRefused(false)
    timer.current = window.setTimeout(() => setRefused(true), REFUSAL_MS)
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [url])

  return (
    <div className="relative h-full w-full">
      <iframe
        src={url}
        title={title}
        // Scripts and same-origin are both needed for a real site to function
        // at all. This is a deliberate widening relative to the report surface,
        // and it is safe for a different reason: the frame holds a REMOTE
        // origin, so the browser's own origin isolation applies. The report
        // surface cannot rely on that, because its content has no origin of its
        // own to be isolated by.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        referrerPolicy="no-referrer"
        className="h-full w-full border-0 bg-transparent"
        onLoad={() => {
          setLoaded(true)
          setRefused(false)
          if (timer.current !== null) clearTimeout(timer.current)
        }}
        data-testid="web-frame"
      />
      {refused && !loaded ? (
        <div className="absolute inset-0 flex flex-col justify-center gap-2 bg-[var(--color-abyss)]/85 p-5">
          <p className="text-[11px] tracking-[0.18em] text-[var(--color-caution)] uppercase">
            Refused embedding
          </p>
          <p className="text-[12px] leading-relaxed text-[var(--color-mist)]">
            This site sends headers that forbid being framed. Nothing here is broken — open it
            directly, or ask SHIVA to stream the window instead.
          </p>
          <p className="font-mono text-[11px] break-all text-[var(--color-smoke)]">{url}</p>
        </div>
      ) : null}
    </div>
  )
}
