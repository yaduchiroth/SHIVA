/**
 * Data source contracts — Phase 3.
 *
 * One shared shape for every source, because the panels that render them
 * shouldn't each invent their own loading, staleness and failure handling.
 *
 * The `DataResult` union is the important part: a source can be unconfigured,
 * failed, or live, and the UI is forced to distinguish them. That's what stops
 * a missing API key from silently rendering as an empty-but-plausible panel —
 * the most common way dashboards end up lying to the people reading them.
 */

export type DataResult<T> =
  | { status: 'live'; data: T; fetchedAt: number }
  | { status: 'unconfigured'; missing: string[] }
  | { status: 'error'; message: string; at: number }

export interface DataSource<T> {
  readonly id: string
  /** Env vars this source needs; surfaced in the UI when unconfigured. */
  readonly requires: readonly string[]
  /** Minimum interval between fetches, ms. */
  readonly refreshMs: number
  fetch(signal?: AbortSignal): Promise<DataResult<T>>
}

// ── Schedule ────────────────────────────────────────────────────────────────
export interface CalendarEvent {
  id: string
  title: string
  start: string // ISO 8601
  end: string
  location?: string
  attendees?: number
  /** Overlaps another event — drives the conflict readout. */
  conflicting?: boolean
}

// ── Inbox ───────────────────────────────────────────────────────────────────
export interface MailSummary {
  unread: number
  /** Threads the brain judged to need a reply. */
  needsReply: number
  topSenders: { name: string; count: number }[]
}

// ── Projects / coding companion ─────────────────────────────────────────────
export interface RepoSummary {
  name: string
  defaultBranch: string
  openPullRequests: number
  /** PRs where the user is a requested reviewer. */
  awaitingReview: number
  lastCommitAt: string
  /** Latest CI conclusion on the default branch. */
  ciStatus: 'passing' | 'failing' | 'pending' | 'unknown'
}
