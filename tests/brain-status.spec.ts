import { expect, test } from '@playwright/test'
import { GeminiBrain } from '@/adapters/brain/gemini'
import type { BrainStatus } from '@/adapters/brain/types'

/**
 * The readiness probe.
 *
 * These exist because of a specific incident: SHIVA displayed "No API key — set
 * GEMINI_API_KEY in .env.local" while holding a key that authenticated
 * perfectly, at that exact moment, on the first try. Nothing was broken about
 * the key. What was broken was that `configured` returned
 * `Boolean(process.env.GEMINI_API_KEY)` and the UI reported it as readiness — a
 * claim about a string, presented as a claim about the world.
 *
 * The property under test throughout is therefore not "does it work" but **does
 * it distinguish**. Four unrelated problems used to collapse into one sentence,
 * and each of the four has a different fix — a file on your machine, Google's
 * console, one line of config, and your network respectively.
 */

const REAL_FETCH = globalThis.fetch

/** Replaces fetch for one assertion. Always restored, including on failure. */
async function withFetch(
  impl: (input: string) => Response | Promise<Response>,
  body: () => Promise<void>,
): Promise<void> {
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(impl(String(input)))) as typeof fetch
  try {
    await body()
  } finally {
    globalThis.fetch = REAL_FETCH
  }
}

const modelList = (...names: string[]) =>
  new Response(JSON.stringify({ models: names.map((n) => ({ name: `models/${n}` })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const googleError = (status: number, message: string, symbol?: string) =>
  new Response(JSON.stringify({ error: { code: status, message, status: symbol } }), { status })

test.describe('no credential', () => {
  test('reports no-key without touching the network', async () => {
    let called = false
    await withFetch(
      () => {
        called = true
        return modelList('gemini-flash-latest')
      },
      async () => {
        const status = await new GeminiBrain('gemini-flash-latest', undefined).verify()
        expect(status).toEqual({ status: 'no-key' } satisfies BrainStatus)
      },
    )
    // A missing key is knowable locally. Spending a round trip to learn it
    // would make the slowest case the one that needs no network at all.
    expect(called, 'no-key must not require a request').toBe(false)
  })

  test('an empty string counts as no key', async () => {
    const status = await new GeminiBrain('gemini-flash-latest', '').verify()
    expect(status.status).toBe('no-key')
  })
})

test.describe('a credential the provider refuses', () => {
  test('reports rejected, not no-key', async () => {
    // The distinction that matters: the user has a key, and being told they
    // do not sends them to fix a file that is already correct.
    await withFetch(
      () => googleError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT'),
      async () => {
        const status = await new GeminiBrain('gemini-flash-latest', 'bad').verify()
        expect(status.status).toBe('rejected')
      },
    )
  })

  test("carries Google's own message through intact", async () => {
    // The SERVICE_DISABLED response is the one that matters most, and it puts
    // the sentence naming the fix at the END. The previous code sliced the body
    // at 180 characters, which reliably kept the diagnosis and threw away the
    // cure.
    const long =
      'Generative Language API has not been used in project 1234567890 before or it is ' +
      'disabled. Enable it by visiting ' +
      'https://console.developers.google.com/apis/api/generativelanguage.googleapis.com/overview?project=1234567890 ' +
      'then retry.'

    await withFetch(
      () => googleError(403, long, 'PERMISSION_DENIED'),
      async () => {
        const status = await new GeminiBrain('gemini-flash-latest', 'x').verify()
        expect(status.status).toBe('rejected')
        if (status.status !== 'rejected') return
        expect(status.detail, 'the URL that fixes it must survive').toContain(
          'console.developers.google.com',
        )
        expect(status.detail).toContain('then retry')
        expect(status.detail).toContain('PERMISSION_DENIED')
      },
    )
  })

  test('a non-JSON error body still produces something readable', async () => {
    // Gateways and proxies answer with HTML, and JSON.parse on it must not
    // turn a real failure into a blank message.
    await withFetch(
      () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 }),
      async () => {
        const status = await new GeminiBrain('gemini-flash-latest', 'x').verify()
        expect(status.status).toBe('rejected')
        if (status.status !== 'rejected') return
        expect(status.detail).toContain('502')
      },
    )
  })
})

test.describe('a retired or unavailable model', () => {
  test('is its own status, not a bad key', async () => {
    // This exact failure has already happened once: gemini-2.5-flash was
    // retired for new keys and every request 404'd in a way that read like an
    // authentication problem.
    await withFetch(
      () => modelList('gemini-flash-latest', 'gemini-flash-lite-latest'),
      async () => {
        const status = await new GeminiBrain('gemini-2.5-flash', 'good-key').verify()
        expect(status.status).toBe('model-missing')
        if (status.status !== 'model-missing') return
        expect(status.model).toBe('gemini-2.5-flash')
        // The alternatives are carried so the UI can suggest one instead of
        // just reporting an absence.
        expect(status.available).toContain('gemini-flash-latest')
      },
    )
  })

  test('strips the models/ prefix Google returns', async () => {
    await withFetch(
      () => modelList('gemini-flash-latest'),
      async () => {
        const status = await new GeminiBrain('gemini-flash-latest', 'k').verify()
        expect(status.status, 'a models/ prefix left on would fail every match').toBe('ready')
      },
    )
  })
})

test.describe('a provider that cannot be reached', () => {
  test('is not reported as a bad key', async () => {
    // A proxy, a dropped connection or a timeout says nothing about the
    // credential. Calling it rejected sends someone to rotate a key that was
    // never the problem — which is the mistake this whole change exists to stop.
    globalThis.fetch = (() => Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as typeof fetch
    try {
      const status = await new GeminiBrain('gemini-flash-latest', 'k').verify()
      expect(status.status).toBe('unreachable')
      if (status.status !== 'unreachable') return
      expect(status.detail).toContain('ENOTFOUND')
    } finally {
      globalThis.fetch = REAL_FETCH
    }
  })
})

test.describe('the working case', () => {
  test('reports ready with the model it verified', async () => {
    await withFetch(
      (url) => {
        // Listing models is free and spends no quota — the reason this probe
        // can run on every page load at all.
        expect(url).toContain('/v1beta/models')
        return modelList('gemini-flash-latest', 'gemini-3-flash-preview')
      },
      async () => {
        const status = await new GeminiBrain('gemini-flash-latest', 'k').verify()
        expect(status).toEqual({
          status: 'ready',
          model: 'gemini-flash-latest',
        } satisfies BrainStatus)
      },
    )
  })

  test('configured stays a presence check and nothing more', async () => {
    // Kept deliberately, and deliberately no longer shown to the user as
    // readiness. Naming it honestly is the whole fix.
    expect(new GeminiBrain('m', 'anything').configured).toBe(true)
    expect(new GeminiBrain('m', undefined).configured).toBe(false)
  })
})
