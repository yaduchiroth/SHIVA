'use client'

import { useMemo } from 'react'

/**
 * A model-authored HTML report, rendered where it cannot hurt anything.
 *
 * This is the one surface with a real security problem. The HTML arrives from a
 * language model, and a model that has just read a web page, an email or a
 * repository has read whatever an attacker chose to put there. Dropping that
 * into the page with `dangerouslySetInnerHTML` puts attacker-authored script in
 * the same origin as an authenticated SHIVA session — able to read the brain's
 * conversation, call every API route with the session's cookies, and rewrite
 * the interface around it.
 *
 * So it goes in an iframe with `sandbox=""` — no attribute values at all, which
 * is the maximally restrictive form. That withholds `allow-scripts` (script
 * never runs), `allow-same-origin` (the frame gets a unique opaque origin and
 * cannot reach `parent`, cookies or storage), `allow-forms`, `allow-popups` and
 * `allow-top-navigation`. What survives is markup, tables, inline SVG and CSS —
 * which is the entire point of a report.
 *
 * Sanitising instead was the alternative, and it is strictly weaker: a
 * sanitiser is a denylist of everything anyone has thought of, maintained
 * forever, against a parser with a decade of bypasses. The sandbox is the
 * browser refusing to run the code at all.
 */

/**
 * Injected ahead of the report's own markup.
 *
 * Inline rather than linked: the frame has an opaque origin and no network
 * privileges worth relying on, so a stylesheet URL is a request that may or may
 * not resolve. The palette mirrors `globals.css` for the same reason
 * `palette.ts` does — the frame cannot inherit custom properties across the
 * origin boundary.
 */
const FRAME_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 18px 20px;
    background: transparent;
    color: #e8e8ec;
    font: 13px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, h3 { color: #d6e4ff; font-weight: 500; letter-spacing: 0.02em; margin: 0 0 .5em; }
  h1 { font-size: 1.25rem; } h2 { font-size: 1.05rem; } h3 { font-size: .95rem; }
  p { margin: 0 0 .8em; color: #b4b4c0; }
  a { color: #8fa4c8; }
  code, pre { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .85em; }
  pre { background: #121215; border: 1px solid #2a2a31; border-radius: 6px; padding: 10px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 1em; font-size: .85rem; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #2a2a31; }
  th { color: #7a7a88; font-weight: 500; text-transform: uppercase; letter-spacing: .08em; font-size: .68rem; }
  ul, ol { margin: 0 0 .8em; padding-left: 1.2em; color: #b4b4c0; }
  hr { border: 0; border-top: 1px solid #2a2a31; margin: 1em 0; }
  img, svg { max-width: 100%; height: auto; }
`

export function Report({ html }: { html: string }) {
  const srcDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8">` +
      // Belt and braces on top of the sandbox. The sandbox already stops
      // script running; this stops the document reaching the network at all,
      // so a report cannot beacon out by requesting a remote image with data
      // in its URL. A meta tag rather than the iframe `csp` attribute, which
      // was proposed, shipped behind a flag, and withdrawn.
      `<meta http-equiv="Content-Security-Policy" ` +
      `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">` +
      `<style>${FRAME_CSS}</style></head><body>${html}</body></html>`,
    [html],
  )

  return (
    <iframe
      // Empty on purpose, and not a mistake to be "fixed" by adding
      // allow-scripts: see the note above. An empty sandbox is the strongest
      // one, and every capability it withholds is one this surface does not need.
      sandbox=""
      srcDoc={srcDoc}
      title="Report"
      className="h-full w-full border-0 bg-transparent"
      data-testid="report-frame"
    />
  )
}
