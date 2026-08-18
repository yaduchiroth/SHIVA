/**
 * Finding the other display, and putting a window on it.
 *
 * The Window Management API is Chrome and Edge only — Safari and Firefox have
 * neither `getScreenDetails` nor `screen.isExtended`, and no shim exists because
 * a page genuinely cannot learn about your monitors without the browser's help.
 * So everything here is feature-detected, and the fallback is a window the user
 * drags across once.
 *
 * Neither API is in TypeScript's DOM library yet, so the shapes are declared
 * locally — the same reason `brain/speech.ts` declares `SpeechRecognition`.
 *
 * The arithmetic is separated from the browser calls so it can be tested. There
 * is exactly one interesting decision in it (which screen is "the other one")
 * and it is wrong in two different ways if you take the obvious route: picking
 * the first non-primary screen puts the window on the wrong display when SHIVA
 * is already running on the external one, and picking by index breaks the
 * moment a monitor is unplugged.
 */

/** The parts of `ScreenDetailed` this needs. */
export interface ScreenLike {
  availLeft: number
  availTop: number
  availWidth: number
  availHeight: number
  isPrimary: boolean
  label: string
}

export interface ScreenDetailsLike {
  screens: ScreenLike[]
  currentScreen: ScreenLike
}

interface WindowWithScreens extends Window {
  getScreenDetails?: () => Promise<ScreenDetailsLike>
}

interface ScreenWithExtended extends Screen {
  isExtended?: boolean
}

/**
 * Whether a second display exists.
 *
 * `screen.isExtended` needs no permission at all, which is what lets the
 * affordance appear only when it would do something. Asking for the
 * window-management permission just to find out whether to show a button would
 * be a prompt for nothing, most of the time.
 */
export function hasExtendedDisplay(): boolean {
  if (typeof window === 'undefined') return false
  return (window.screen as ScreenWithExtended).isExtended === true
}

/** Whether the browser can place a window itself, or the user must drag it. */
export function canPlaceWindows(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as WindowWithScreens).getScreenDetails === 'function'
  )
}

/**
 * The screen to send surfaces to.
 *
 * "Not the one SHIVA is on" rather than "not the primary": if you have dragged
 * SHIVA onto the external display — which is exactly what someone with two
 * monitors does — then the primary IS the other one, and picking by `isPrimary`
 * would send every surface back to the window you are looking at.
 *
 * Falls back to the largest remaining screen when several are free, because
 * with three displays the biggest is the one worth filling.
 */
export function pickTargetScreen(details: ScreenDetailsLike): ScreenLike | null {
  const others = details.screens.filter((s) => !sameScreen(s, details.currentScreen))
  if (others.length === 0) return null
  return others.reduce((best, s) =>
    s.availWidth * s.availHeight > best.availWidth * best.availHeight ? s : best,
  )
}

/**
 * Compared by geometry rather than by reference.
 *
 * `currentScreen` is not guaranteed to be reference-identical to the matching
 * entry in `screens` — the spec says it is a live object and implementations
 * have differed — so `!==` silently treats the current screen as a candidate
 * and the window opens on top of itself.
 */
function sameScreen(a: ScreenLike, b: ScreenLike): boolean {
  return a.availLeft === b.availLeft && a.availTop === b.availTop
}

/**
 * The `window.open` features string that fills a screen.
 *
 * Sized to the available area rather than fullscreened: `requestFullscreen`
 * needs a user gesture inside the popup, and making someone click a second time
 * to finish an action they already started is worse than a title bar.
 */
export function windowFeatures(screen: ScreenLike): string {
  return [
    `left=${Math.round(screen.availLeft)}`,
    `top=${Math.round(screen.availTop)}`,
    `width=${Math.round(screen.availWidth)}`,
    `height=${Math.round(screen.availHeight)}`,
    // Chrome only honours the position when the window is a genuine popup.
    'popup=yes',
  ].join(',')
}

export type OpenResult =
  | { placed: 'auto'; label: string }
  /** Opened, but the browser would not place it — drag it across once. */
  | { placed: 'manual' }
  | { placed: 'blocked'; reason: string }

/**
 * Opens the display window, on the other screen where the browser allows it.
 *
 * Must be called from a user gesture: both the permission prompt and
 * `window.open` require one, and a popup opened outside a gesture is blocked
 * silently.
 */
export async function openDisplayWindow(url = '/display'): Promise<OpenResult> {
  if (typeof window === 'undefined') return { placed: 'blocked', reason: 'no window' }

  const name = 'shiva-display'
  const getScreenDetails = (window as WindowWithScreens).getScreenDetails

  if (getScreenDetails) {
    try {
      const details = await getScreenDetails.call(window)
      const target = pickTargetScreen(details)
      if (target) {
        const opened = window.open(url, name, windowFeatures(target))
        if (!opened) return { placed: 'blocked', reason: 'The browser blocked the popup.' }
        return { placed: 'auto', label: target.label || 'display 2' }
      }
    } catch {
      // Permission denied, or no second screen. Neither is an error worth
      // stopping for — the manual path below works regardless.
    }
  }

  const opened = window.open(url, name)
  if (!opened) return { placed: 'blocked', reason: 'The browser blocked the popup.' }
  return { placed: 'manual' }
}
