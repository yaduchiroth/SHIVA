/**
 * The mind's event protocol, as SHIVA understands it.
 *
 * The mind (the Python side, on the Mac) broadcasts everything it does over a
 * WebSocket as `{kind, ts, ...payload}`. SHIVA is now the only client of that
 * bus — the flat HTML HUD it shipped with is replaced by this scene — so this
 * file is the contract between the two halves, and it is transcribed from
 * `mind/bus.py` and the `bus.emit(...)` call sites rather than invented.
 *
 * Two properties matter more than completeness:
 *
 * **Unknown kinds are carried, not dropped or thrown on.** The mind will grow
 * events faster than this file is updated, and a version skew between two
 * repositories is the normal state of affairs, not an error. An unrecognised
 * kind becomes `{kind: 'unknown'}` with its payload intact, so the link stays
 * up and the HUD can still say what it saw.
 *
 * **Payloads are validated, not asserted.** Everything here crosses a process
 * boundary from a language with no static types, where a field that is usually
 * a list is occasionally None. Coercing at the boundary means the rest of SHIVA
 * can trust its own types; casting would move the crash somewhere less
 * diagnosable.
 */

/** The mind's own conversational state, as reported by `bus.state()`. */
export type MindState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'acting'

/** Where a dispatched companion is in its errand. */
export type CompanionState = 'dormant' | 'working' | 'returning' | 'done' | 'failed'

export interface CompanionSpec {
  slug: string
  name: string
  role: string
  /** Hex colour from the companion's own front matter. */
  color: string
  /** Optional orbit hints: radius, incline, phase. */
  orbit: { radius?: number; incline?: number; phase?: number }
}

export interface ChartSeriesWire {
  name: string
  values: number[]
}

export interface DeviceSpec {
  name: string
  /** Free-form; the mind's device list is heterogeneous by design. */
  status?: string
  detail?: string
  online?: boolean
}

export type MindEvent =
  | { kind: 'state'; value: MindState }
  | { kind: 'log'; text: string }
  | { kind: 'transcript'; who: string; text: string }
  | { kind: 'presence'; name: string; known: boolean }
  | { kind: 'odinmode'; value: 'awake' | 'asleep' }
  /** A short written note for the HUD. */
  | { kind: 'card'; title: string; body: string }
  /** Model-authored HTML. Rendered sandboxed — see surfaces/content/Report. */
  | { kind: 'report'; title: string; html: string }
  | {
      kind: 'chart'
      title: string
      ctype: 'bar' | 'line'
      labels: string[]
      series: ChartSeriesWire[]
      unit: string
    }
  | { kind: 'webview'; url: string; title: string }
  /** Clear whatever is pinned to the big screen. */
  | { kind: 'wellclear' }
  | { kind: 'roster'; items: CompanionSpec[] }
  | { kind: 'dispatch'; id: string; slug: string; task: string }
  | { kind: 'dispatch_return'; id: string; slug: string; ok: boolean; summary: string }
  | { kind: 'dispatch_clear' }
  | { kind: 'companion'; id: string; slug: string; state: CompanionState }
  | { kind: 'devices'; items: DeviceSpec[] }
  | { kind: 'iot'; items: DeviceSpec[] }
  /** Base64 JPEG frames. Bulky — see `HEAVY_KINDS`. */
  | { kind: 'camera'; jpg: string; names: string[] }
  | { kind: 'screen'; jpg: string }
  | { kind: 'raven'; title: string; body: string }
  | { kind: 'unknown'; name: string; payload: Record<string, unknown> }

/**
 * Kinds the mind never replays to a reconnecting client.
 *
 * Mirrors `Bus.NO_REPLAY`. Transcribed here not to duplicate the rule — the mind
 * enforces it — but because SHIVA has to behave correctly when it *is* honoured:
 * these are moment-in-time events, and a reconnect that redrew dispatch beams
 * for errands finished ten minutes ago would be worse than showing nothing.
 */
export const NO_REPLAY: ReadonlySet<string> = new Set([
  'audio',
  'camera',
  'screen',
  'dispatch',
  'dispatch_return',
  'dispatch_clear',
  'companion',
  'companion_tool',
  'companion_stream',
])

/**
 * Standing state the mind always resends on connect, ahead of the replay window.
 *
 * Mirrors `Bus.STICKY`. Without it, a reloaded page has no companions — the
 * roster was emitted once at startup and scrolled out of the 30-event history
 * long ago.
 */
export const STICKY: ReadonlySet<string> = new Set(['roster', 'devices'])

/**
 * Base64 image frames, which are the only genuinely expensive feed on the bus.
 *
 * The mind sends camera frames whenever a HUD is open, several per second, as
 * base64 JPEG inside JSON. Subscribing to them when nothing is displaying them
 * costs bandwidth and a JSON parse per frame for nothing, which is exactly what
 * The mind's `subscribe` message exists to avoid.
 */
export const HEAVY_KINDS: readonly string[] = ['camera', 'screen', 'audio']

// ── Coercion helpers ─────────────────────────────────────────────────────────

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const bool = (v: unknown): boolean => v === true
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => str(s)) : [])

const numList = (v: unknown): number[] =>
  Array.isArray(v)
    ? v.map((n) => (typeof n === 'number' ? n : Number(n))).filter((n) => Number.isFinite(n))
    : []

const objList = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    : []

const COMPANION_STATES: ReadonlySet<string> = new Set([
  'dormant',
  'working',
  'returning',
  'done',
  'failed',
])

const ODIN_STATES: ReadonlySet<string> = new Set([
  'idle',
  'listening',
  'thinking',
  'speaking',
  'acting',
])

/**
 * Turns one wire message into an event.
 *
 * Returns null only when the message is not a mind event at all — no object,
 * no `kind`. Anything with a kind comes back, even if unrecognised, because a
 * newer the mind talking to an older SHIVA is a normal situation and not one worth
 * dropping the connection over.
 */
export function parseMindEvent(raw: unknown): MindEvent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const msg = raw as Record<string, unknown>
  const kind = msg.kind
  if (typeof kind !== 'string' || kind.length === 0) return null

  switch (kind) {
    case 'state': {
      const value = str(msg.value)
      return { kind, value: (ODIN_STATES.has(value) ? value : 'idle') as MindState }
    }
    case 'log':
      return { kind, text: str(msg.text) }
    case 'transcript':
      return { kind, who: str(msg.who, 'mind'), text: str(msg.text) }
    case 'presence':
      return { kind, name: str(msg.name, 'Guest'), known: bool(msg.known) }
    case 'odinmode':
      return { kind, value: str(msg.value) === 'asleep' ? 'asleep' : 'awake' }
    case 'card':
      return { kind, title: str(msg.title), body: str(msg.body) }
    case 'report':
      return { kind, title: str(msg.title), html: str(msg.html) }
    case 'chart':
      return {
        kind,
        title: str(msg.title),
        ctype: str(msg.ctype) === 'line' ? 'line' : 'bar',
        labels: strList(msg.labels),
        // the mind already normalises values/data/y on its side, but it is one
        // `or` there and a blank chart here if it ever misses one.
        series: objList(msg.series)
          .map((s) => ({
            name: str(s.name ?? s.label),
            values: numList(s.values ?? s.data ?? s.y),
          }))
          .filter((s) => s.values.length > 0),
        unit: str(msg.unit),
      }
    case 'webview': {
      const url = str(msg.url)
      return { kind, url, title: str(msg.title, url) }
    }
    case 'wellclear':
    case 'dispatch_clear':
      return { kind }
    case 'roster':
      return {
        kind,
        items: objList(msg.items).map((c) => {
          const orbit =
            typeof c.orbit === 'object' && c.orbit !== null
              ? (c.orbit as Record<string, unknown>)
              : {}
          return {
            slug: str(c.slug),
            name: str(c.name, str(c.slug)),
            role: str(c.role),
            color: str(c.color, '#e8b93c'),
            orbit: {
              radius: num(orbit.radius),
              incline: num(orbit.incline),
              phase: num(orbit.phase),
            },
          }
        }),
      }
    case 'dispatch':
      return { kind, id: str(msg.id), slug: str(msg.slug), task: str(msg.task) }
    case 'dispatch_return':
      return {
        kind,
        id: str(msg.id),
        slug: str(msg.slug),
        // Absent means it came back fine; the mind only sets this on failure.
        ok: msg.ok === undefined ? true : bool(msg.ok),
        summary: str(msg.summary ?? msg.result),
      }
    case 'companion': {
      const state = str(msg.state)
      return {
        kind,
        id: str(msg.id),
        slug: str(msg.slug),
        state: (COMPANION_STATES.has(state) ? state : 'working') as CompanionState,
      }
    }
    case 'devices':
    case 'iot':
      return {
        kind,
        items: objList(msg.items).map((d) => ({
          name: str(d.name ?? d.label ?? d.slug),
          status: str(d.status) || undefined,
          detail: str(d.detail ?? d.note) || undefined,
          online: d.online === undefined ? undefined : bool(d.online),
        })),
      }
    case 'camera':
      return { kind, jpg: str(msg.jpg), names: strList(msg.names) }
    case 'screen':
      return { kind, jpg: str(msg.jpg) }
    case 'raven':
      return { kind, title: str(msg.title), body: str(msg.body) }
    default: {
      const { kind: _kind, ...payload } = msg
      return { kind: 'unknown', name: kind, payload }
    }
  }
}

/**
 * Every kind SHIVA knows about, minus the image blobs.
 *
 * For `MindClient.setKinds` when a client genuinely wants to drop the camera
 * and screen feeds. The mind's subscription is a whitelist, so opting out of two
 * kinds means naming all the others — and accepting that a kind the mind gains
 * later will not arrive until this list is updated. That is why it is not the
 * default.
 */
export function lightKinds(): string[] {
  return [
    'state',
    'log',
    'transcript',
    'presence',
    'odinmode',
    'card',
    'report',
    'chart',
    'webview',
    'wellclear',
    'roster',
    'roster_pending',
    'dispatch',
    'dispatch_return',
    'dispatch_clear',
    'companion',
    'companion_tool',
    'companion_stream',
    'devices',
    'iot',
    'raven',
    'knowledge',
    'smriti',
    'routine',
    'workflow',
    'usage',
    'calendar',
    'meetings',
    'email',
    'ringlight',
  ].filter((k) => !HEAVY_KINDS.includes(k))
}
