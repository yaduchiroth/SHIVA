/**
 * Lets a tracked hand operate real DOM.
 *
 * Everything on an AR surface is genuine HTML — a report with tables, a chart,
 * an embedded page — positioned in 3D. WebGL raycasting cannot touch any of it,
 * because none of it is in the scene graph. So the hand cursor is projected
 * back to screen coordinates and the element underneath is driven with
 * synthesised pointer events, which is the only mechanism that reaches both our
 * own markup and content we did not write.
 *
 * Three things are worth knowing before relying on this:
 *
 *   - **CSS `:hover` will not fire.** It is driven by the real cursor and no
 *     synthetic event can trigger it. Hover state is published as a
 *     `data-hand-hover` attribute instead, which styles can select on.
 *   - **Synthetic events are `isTrusted: false`.** Anything gated on a genuine
 *     user gesture — clipboard writes, fullscreen, unmuting audio — will refuse.
 *     Those paths keep a real pointer affordance.
 *   - **Dragging scrolls rather than drags**, when the press lands inside
 *     something scrollable. That is the touch idiom, it is what a hand in the
 *     air actually wants, and it is why a drag past the slop threshold cancels
 *     the click it would otherwise have produced.
 *
 * `pointerType` is `pen`: a hand is a single point that hovers before it
 * presses, which is exactly what a pen is and exactly what a touch is not.
 */

/** A stable id, so a listener tracking pointers sees one hand, not many. */
const POINTER_ID = 4242

/**
 * How far a press may travel and still count as a click, in CSS pixels.
 *
 * Generous, because a hand held in the air is not still. At a mouse-like 3px
 * nothing would ever register as a click; at 40 a deliberate scroll starts
 * firing them.
 */
export const CLICK_SLOP = 18

/** Marks the element a hand is over. Styles select on this; `:hover` cannot. */
export const HOVER_ATTR = 'data-hand-hover'

interface BridgeState {
  hovered: Element | null
  /** What the press started on, for deciding whether an up is a click. */
  pressedOn: Element | null
  /** The nearest scrollable ancestor of the press target, if any. */
  scroller: Element | null
  x: number
  y: number
  pressX: number
  pressY: number
  /** Set once a press has moved past CLICK_SLOP; suppresses the click. */
  dragged: boolean
  down: boolean
}

const state: BridgeState = {
  hovered: null,
  pressedOn: null,
  scroller: null,
  x: 0,
  y: 0,
  pressX: 0,
  pressY: 0,
  dragged: false,
  down: false,
}

function pointerEvent(type: string, x: number, y: number, buttons: number): PointerEvent {
  return new PointerEvent(type, {
    pointerId: POINTER_ID,
    pointerType: 'pen',
    isPrimary: true,
    bubbles: true,
    cancelable: true,
    // Without this the event stops at a shadow boundary, which is where an
    // embedded widget's internals usually live.
    composed: true,
    clientX: x,
    clientY: y,
    buttons,
    button: buttons ? 0 : -1,
  })
}

/**
 * The nearest ancestor that can actually scroll.
 *
 * Both halves matter: an element can have `overflow: auto` and no overflow to
 * scroll, in which case grabbing it should not swallow the drag; and it can
 * overflow with `overflow: hidden`, in which case it is deliberately not
 * scrollable and must not be scrolled anyway.
 */
export function scrollableAncestor(el: Element | null): Element | null {
  let node: Element | null = el
  while (node && node !== document.body) {
    const style = getComputedStyle(node)
    const scrolls = /(auto|scroll|overlay)/.test(style.overflowY)
    if (scrolls && node.scrollHeight > node.clientHeight + 1) return node
    node = node.parentElement
  }
  return null
}

function setHovered(next: Element | null, x: number, y: number): void {
  const prev = state.hovered
  if (prev === next) return
  if (prev) {
    prev.removeAttribute(HOVER_ATTR)
    prev.dispatchEvent(pointerEvent('pointerout', x, y, 0))
    prev.dispatchEvent(pointerEvent('pointerleave', x, y, 0))
  }
  if (next) {
    next.setAttribute(HOVER_ATTR, '')
    next.dispatchEvent(pointerEvent('pointerover', x, y, 0))
    next.dispatchEvent(pointerEvent('pointerenter', x, y, 0))
  }
  state.hovered = next
}

/**
 * One frame of hand input.
 *
 * @param x screen x in CSS pixels, or null when no hand is present
 * @param y screen y in CSS pixels
 * @param pressed whether the hand is pinching
 */
export function driveDomPointer(x: number | null, y: number | null, pressed: boolean): void {
  if (x === null || y === null) {
    // A hand leaving the frame must release anything it was holding. Without
    // this a press survives the hand's disappearance and the next hand to
    // arrive is already holding something.
    if (state.down) releaseAt(state.x, state.y)
    setHovered(null, state.x, state.y)
    return
  }

  // The canvas is not a target. Everything in the 3D scene is already driven
  // by `useInteractionDriver` reading the hand frame directly, and feeding it a
  // second, synthetic stream would run every gesture twice — once through the
  // hand path and once through the pointer path. It would also raycast in the
  // wrong place: R3F reads `offsetX`/`offsetY`, which a constructed event
  // leaves at zero, so every synthetic move would report the canvas corner.
  const hit = document.elementFromPoint(x, y)
  const target = hit instanceof HTMLCanvasElement ? null : hit
  const buttons = pressed ? 1 : 0

  if (!target && !state.down) {
    setHovered(null, x, y)
    state.x = x
    state.y = y
    return
  }

  if (!state.down) setHovered(target, x, y)
  ;(state.down ? (state.pressedOn ?? target) : target)?.dispatchEvent(
    pointerEvent('pointermove', x, y, buttons),
  )

  if (pressed && !state.down) {
    state.down = true
    state.pressedOn = target
    state.scroller = scrollableAncestor(target)
    state.pressX = x
    state.pressY = y
    state.dragged = false
    target?.dispatchEvent(pointerEvent('pointerdown', x, y, 1))
  } else if (pressed && state.down) {
    const dx = x - state.pressX
    const dy = y - state.pressY
    if (!state.dragged && Math.hypot(dx, dy) > CLICK_SLOP) state.dragged = true
    if (state.scroller) {
      // Content follows the hand, so pulling down reveals what is above —
      // the same direction as dragging a sheet of paper, and the opposite of
      // a scrollbar.
      state.scroller.scrollTop -= y - state.y
    }
  } else if (!pressed && state.down) {
    releaseAt(x, y)
  }

  state.x = x
  state.y = y
}

function releaseAt(x: number, y: number): void {
  const on = state.pressedOn
  state.down = false
  on?.dispatchEvent(pointerEvent('pointerup', x, y, 0))
  // A drag that scrolled is not a click, exactly as on a touchscreen —
  // otherwise every scroll also activates whatever it started on.
  if (on && !state.dragged) {
    on.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
      }),
    )
  }
  state.pressedOn = null
  state.scroller = null
  state.dragged = false
}

/** Drops all state. For unmount, and for tests that must not leak into each other. */
export function resetPointerBridge(): void {
  if (state.hovered) state.hovered.removeAttribute(HOVER_ATTR)
  state.hovered = null
  state.pressedOn = null
  state.scroller = null
  state.down = false
  state.dragged = false
  state.x = 0
  state.y = 0
}

/** Read-only view, for the debug overlay and the test suite. */
export const pointerBridgeState = (): Readonly<BridgeState> => state
