import { DisplayShell } from '@/spatial/surfaces/DisplayShell'

/**
 * SHIVA's second window, for an extended display.
 *
 * A separate route rather than a mode of the main page: it must be openable by
 * `window.open` with its own document, because that is the only way a browser
 * will put pixels on another monitor.
 */
export default function DisplayPage() {
  return <DisplayShell />
}
