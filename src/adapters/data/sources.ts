import type {
  CalendarEvent,
  DataResult,
  DataSource,
  MailSummary,
  RepoSummary,
} from './types'

/**
 * Phase 3 source stubs.
 *
 * Each reports `unconfigured` with the exact env vars it needs, so the UI can
 * tell the user precisely what's missing rather than showing a dead panel. None
 * of them fabricates data — see the note in `types.ts` on why that matters.
 *
 * Implementation notes are recorded per-source while the requirements are
 * fresh, so Phase 3 starts from decisions rather than from research.
 */

const unconfigured = <T,>(requires: readonly string[]): DataResult<T> => ({
  status: 'unconfigured',
  missing: requires.filter((key) => !process.env[key]),
})

/**
 * Google Calendar.
 *
 * Needs a full OAuth 2.0 authorisation-code flow with refresh tokens, not an
 * API key — calendars are per-user data. Scope should be
 * `calendar.readonly` unless SHIVA is later allowed to create events, and
 * `calendar.events` only then; asking for write access up front makes the
 * consent screen materially scarier for no Phase 3 benefit.
 */
export const calendarSource: DataSource<CalendarEvent[]> = {
  id: 'google-calendar',
  requires: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const,
  refreshMs: 5 * 60 * 1000,
  async fetch() {
    return unconfigured<CalendarEvent[]>(this.requires)
  },
}

/**
 * Gmail.
 *
 * Same OAuth client as Calendar — one consent flow covering both scopes is
 * markedly better than two. Use `gmail.metadata` scope where possible: it
 * returns headers without message bodies, which is enough for the unread and
 * sender summary and avoids requesting access to the content of every email.
 */
export const mailSource: DataSource<MailSummary> = {
  id: 'gmail',
  requires: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const,
  refreshMs: 3 * 60 * 1000,
  async fetch() {
    return unconfigured<MailSummary>(this.requires)
  },
}

/**
 * GitHub — the coding companion's data half.
 *
 * A fine-grained PAT with read-only `contents`, `pull_requests` and `checks` is
 * sufficient and is far easier to reason about than a classic token. Prefer the
 * GraphQL API here: the summary below needs PRs, review requests and CI status,
 * which is three REST round-trips per repo but a single GraphQL query.
 */
export const reposSource: DataSource<RepoSummary[]> = {
  id: 'github',
  requires: ['GITHUB_TOKEN'] as const,
  refreshMs: 2 * 60 * 1000,
  async fetch() {
    return unconfigured<RepoSummary[]>(this.requires)
  },
}

export const SOURCES = [calendarSource, mailSource, reposSource] as const
