/**
 * Mints a short-lived credential for the browser's voice-agent socket.
 *
 * This route exists for one reason, and it is not convenience. A browser cannot
 * set headers on a WebSocket, so the credential has to travel in the
 * subprotocol — which means whatever the client connects with is visible in
 * devtools, in the page's memory, and to any script running on the page. Send
 * the real `DEEPGRAM_API_KEY` there and you have published an account key with a
 * $200 balance to every visitor.
 *
 * So the server holds the real key and hands out ephemeral tokens that expire in
 * seconds. **If the grant fails, this route returns an error — it never falls
 * back to the real key.** That fallback is the tempting one-line "fix" when the
 * grant endpoint 404s during development, and it is precisely the bug that
 * leaks the account.
 */

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

import { GRANT_PATH } from '@/adapters/voice/deepgram'

/**
 * Token lifetime. Long enough to cover a slow connection, short enough that a
 * leaked one is worthless. Deepgram scopes the token to the socket, so a longer
 * TTL buys nothing.
 */
const TTL_SECONDS = 30

/** Lets the UI say "voice is not configured" instead of failing on click. */
export function GET() {
  return Response.json({ configured: Boolean(process.env.DEEPGRAM_API_KEY) })
}

export async function POST() {
  const apiKey = process.env.DEEPGRAM_API_KEY
  if (!apiKey) {
    return Response.json(
      { error: 'DEEPGRAM_API_KEY is not set. Add it to .env.local.' },
      { status: 501 },
    )
  }

  let res: Response
  try {
    res = await fetch(GRANT_PATH, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ ttl_seconds: TTL_SECONDS }),
    })
  } catch (err) {
    return Response.json(
      { error: `Could not reach Deepgram: ${(err as Error).message}` },
      { status: 502 },
    )
  }

  if (!res.ok) {
    // The body is Deepgram's own error text and usually names the problem
    // exactly ("insufficient permissions", "project not found"). Passing it
    // through is the difference between a fixable message and "502".
    const detail = await res.text().catch(() => '')
    return Response.json(
      {
        error: `Deepgram token grant returned ${res.status}`,
        detail: detail.slice(0, 300),
      },
      { status: 502 },
    )
  }

  const body = (await res.json().catch(() => null)) as {
    access_token?: string
    expires_in?: number
  } | null

  const token = body?.access_token
  if (!token) {
    // Shape mismatch rather than a failure — the field may have been renamed.
    // Report it rather than falling through to something that "works".
    return Response.json(
      { error: 'Deepgram grant succeeded but returned no access_token.' },
      { status: 502 },
    )
  }

  return Response.json(
    { token, expiresIn: body?.expires_in ?? TTL_SECONDS },
    // A credential must never be cached, by us or by anything in between.
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
