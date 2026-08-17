import { GeminiBrain } from '@/adapters/brain/gemini'
import { TOOLS, buildSystemPrompt } from '@/adapters/brain/commands'
import type { Message } from '@/adapters/brain/types'
import type { ModuleId } from '@/core/types'

/**
 * The brain endpoint.
 *
 * Server-side so the API key stays server-side — the entire reason this route
 * exists rather than calling Gemini from the browser.
 *
 * Streams Server-Sent Events. The client needs tokens as they arrive: the
 * holographic text assembles progressively and speech synthesis starts on the
 * first sentence, so buffering the whole response would waste the majority of
 * the perceived latency budget.
 */

export const runtime = 'edge'
// Never cache: every request carries different conversation state.
export const dynamic = 'force-dynamic'

interface BrainRequestBody {
  messages: Message[]
  context?: {
    activeModule?: ModuleId
    temperatureC?: number | null
    condition?: string | null
    location?: string | null
  }
}

export async function POST(request: Request) {
  let body: BrainRequestBody
  try {
    body = (await request.json()) as BrainRequestBody
  } catch {
    return new Response('Invalid JSON body', { status: 400 })
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response('messages is required', { status: 400 })
  }

  // Bound the history server-side. A client that never trims would grow the
  // context — and the bill — without limit.
  const messages = body.messages.slice(-20)

  const brain = new GeminiBrain()
  const system = buildSystemPrompt({
    activeModule: body.context?.activeModule ?? 'system',
    temperatureC: body.context?.temperatureC ?? null,
    condition: body.context?.condition ?? null,
    location: body.context?.location ?? null,
  })

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }

      try {
        for await (const event of brain.stream({
          messages,
          tools: TOOLS,
          system,
          signal: request.signal,
        })) {
          send(event)
        }
      } catch (err) {
        // The client disconnecting aborts the request; that's normal, not an
        // error worth serialising into a stream nobody is reading.
        if (!request.signal.aborted) {
          send({ type: 'error', message: (err as Error).message })
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx and similar proxies buffer responses by default, which would hold
      // the whole stream until completion and silently undo the streaming.
      'x-accel-buffering': 'no',
    },
  })
}

/** Capability probe, so the UI can say what's wrong before the user speaks. */
export async function GET() {
  const brain = new GeminiBrain()
  return Response.json({
    configured: brain.configured,
    model: brain.configured ? brain.model : null,
  })
}
