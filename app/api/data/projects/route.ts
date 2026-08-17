import { NextResponse } from 'next/server'

/**
 * Repository status — the coding companion's data half.
 *
 * One GraphQL query rather than the REST equivalent. The summary needs, per
 * repo: open PR count, how many await your review, the last commit, and CI
 * status on the default branch. Over REST that is four round-trips per
 * repository; here it is one request for all of them, which matters as soon as
 * you follow more than a couple of repos.
 *
 * Needs `GITHUB_TOKEN` — a fine-grained PAT with read-only `contents`,
 * `pull_requests` and `checks`. Without it this reports `unconfigured` naming
 * the missing variable, rather than rendering an empty panel that looks like
 * "you have no projects".
 */

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const QUERY = `
query($first: Int!) {
  viewer {
    login
    repositories(first: $first, orderBy: {field: PUSHED_AT, direction: DESC}, ownerAffiliations: [OWNER, COLLABORATOR]) {
      nodes {
        name
        defaultBranchRef {
          name
          target {
            ... on Commit {
              committedDate
              statusCheckRollup { state }
            }
          }
        }
        pullRequests(states: OPEN, first: 50) {
          totalCount
          nodes { reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } } } } }
        }
      }
    }
  }
}`

interface GraphQLResponse {
  data?: {
    viewer?: {
      login: string
      repositories: {
        nodes: {
          name: string
          defaultBranchRef: {
            name: string
            target?: { committedDate?: string; statusCheckRollup?: { state?: string } | null }
          } | null
          pullRequests: {
            totalCount: number
            nodes: {
              reviewRequests: { nodes: { requestedReviewer?: { login?: string } | null }[] }
            }[]
          }
        }[]
      }
    }
  }
  errors?: { message: string }[]
}

/** GitHub's rollup states → the four our UI distinguishes. */
function ciStatus(state: string | undefined): 'passing' | 'failing' | 'pending' | 'unknown' {
  switch (state) {
    case 'SUCCESS':
      return 'passing'
    case 'FAILURE':
    case 'ERROR':
      return 'failing'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      // No checks configured is genuinely different from checks that failed.
      return 'unknown'
  }
}

export async function GET() {
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    return NextResponse.json({
      status: 'unconfigured' as const,
      missing: ['GITHUB_TOKEN'],
      fetchedAt: Date.now(),
    })
  }

  try {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'shiva-spatial-os',
      },
      signal: AbortSignal.timeout(9000),
      body: JSON.stringify({ query: QUERY, variables: { first: 8 } }),
    })

    if (res.status === 401) {
      return NextResponse.json({
        status: 'error' as const,
        reason: 'GitHub rejected the token. Check it has not expired.',
        fetchedAt: Date.now(),
      })
    }
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`)

    const body = (await res.json()) as GraphQLResponse
    // GraphQL reports errors with a 200, so the status code alone proves nothing.
    if (body.errors?.length) throw new Error(body.errors[0]!.message)

    const viewer = body.data?.viewer
    if (!viewer) throw new Error('No viewer in response — token may lack scopes')

    const repos = viewer.repositories.nodes.map((repo) => {
      const target = repo.defaultBranchRef?.target
      const awaitingReview = repo.pullRequests.nodes.filter((pr) =>
        pr.reviewRequests.nodes.some((r) => r.requestedReviewer?.login === viewer.login),
      ).length

      return {
        name: repo.name,
        defaultBranch: repo.defaultBranchRef?.name ?? 'main',
        openPullRequests: repo.pullRequests.totalCount,
        awaitingReview,
        lastCommitAt: target?.committedDate ?? '',
        ciStatus: ciStatus(target?.statusCheckRollup?.state),
      }
    })

    return NextResponse.json({ status: 'live' as const, data: repos, fetchedAt: Date.now() })
  } catch (err) {
    return NextResponse.json({
      status: 'error' as const,
      reason: err instanceof Error ? err.message : 'unknown error',
      fetchedAt: Date.now(),
    })
  }
}
