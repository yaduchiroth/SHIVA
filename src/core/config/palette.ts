/**
 * Literal colour values for the design tokens.
 *
 * `globals.css` is the source of truth for anything the browser paints, but two
 * consumers can't read CSS custom properties: Canvas2D (which draws the panel
 * faces) and three.js materials (which need real colour values, not strings the
 * GPU can't resolve). Both need the literals, so they're mirrored here once
 * rather than hard-coded at each call site.
 *
 * Keep in sync with the `@theme` block in `app/globals.css`.
 */
export const PALETTE = {
  void: '#060607',
  abyss: '#0a0a0c',
  carbon: '#121215',
  graphite: '#1c1c21',
  steel: '#2a2a31',
  ash: '#4a4a55',
  smoke: '#7a7a88',
  mist: '#b4b4c0',
  bone: '#e8e8ec',
  signal: '#d6e4ff',
  'signal-dim': '#8fa4c8',
  nominal: '#4ade9a',
  caution: '#f0b429',
  critical: '#ff5a52',
  tracking: '#7c9cff',
} as const

export type PaletteKey = keyof typeof PALETTE

/**
 * Resolves a `var(--color-x)` token to its literal value.
 *
 * Accepts a literal colour unchanged, so callers can pass either form without
 * branching. Falls back to `signal` rather than throwing: an unknown token
 * should make a panel the wrong colour, not crash the render loop.
 */
export function resolveColor(token: string): string {
  const match = /^var\(--color-([a-z-]+)\)$/.exec(token.trim())
  if (!match) return token
  const key = match[1] as PaletteKey
  return PALETTE[key] ?? PALETTE.signal
}
