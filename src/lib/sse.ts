/**
 * Server-Sent Events framing.
 *
 * Extracted because the same subtle bug was written twice — once in the Gemini
 * adapter and once in the browser client — and the second copy is exactly the
 * kind of thing that gets fixed in one place and left broken in the other.
 *
 * The bug: SSE frames are separated by a blank line, so a naive reader splits on
 * `\n\n` and keeps the tail as an incomplete frame. But the FINAL frame has no
 * trailing separator, and a short response frequently arrives as a single chunk
 * that is entirely "final" — so the tail is a complete frame, not a partial one.
 * Discarding it at end-of-stream silently dropped whole responses: the request
 * succeeded, the buffer held the entire reply, and the parser reported nothing.
 *
 * `flush()` exists solely to make forgetting that impossible.
 */
export class SseFramer {
  private buffer = ''

  /** Feeds a decoded chunk and returns the frames that are now complete. */
  push(chunk: string): string[] {
    this.buffer += chunk
    const frames = this.buffer.split('\n\n')
    // The last element is either a partial frame or an empty string; either way
    // it is not yet complete.
    this.buffer = frames.pop() ?? ''
    return frames.filter((f) => f.trim().length > 0)
  }

  /** Call once the stream ends. Returns the trailing frame, if any. */
  flush(): string[] {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest ? [rest] : []
  }
}

/**
 * Extracts the JSON payload from a frame's `data:` line.
 *
 * @returns the payload, or null for comments, keep-alives and terminators.
 */
export function sseData(frame: string): string | null {
  const line = frame.split('\n').find((l) => l.startsWith('data:'))
  if (!line) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return null
  return payload
}
