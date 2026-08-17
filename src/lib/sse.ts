/**
 * Server-Sent Events framing.
 *
 * Extracted because the same subtle bug was written twice — once in the Gemini
 * adapter and once in the browser client — and the second copy is exactly the
 * kind of thing that gets fixed in one place and left broken in the other.
 *
 * Two separate failures live here, both of which silently truncate a response
 * rather than erroring:
 *
 * 1. **Line endings.** The SSE spec permits LF, CRLF or CR. Gemini uses CRLF,
 *    so a reader splitting on `'\n\n'` finds no separator at all — the whole
 *    stream stays one unsplittable blob and only its first event is ever read.
 *    A 33-frame reply arrived as a single truncated word.
 * 2. **The final frame.** The last frame carries no trailing separator, and a
 *    short reply often arrives as one chunk that is entirely "final". Treating
 *    the tail as always-partial discarded whole responses: request succeeded,
 *    buffer held the answer, parser reported nothing.
 *
 * `flush()` exists to make forgetting the second impossible; the regex handles
 * the first. Both were found by comparing frame counts against the raw upstream
 * — neither produces an error to notice.
 */

/** Frame separator: a blank line, in any of the three legal line endings. */
const SEPARATOR = /\r\n\r\n|\n\n|\r\r/
export class SseFramer {
  private buffer = ''

  /** Feeds a decoded chunk and returns the frames that are now complete. */
  push(chunk: string): string[] {
    this.buffer += chunk
    const frames = this.buffer.split(SEPARATOR)
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
 * Extracts the JSON payload from a frame's `data:` lines.
 *
 * The spec allows a single event to carry several `data:` lines, which are
 * concatenated with newlines. Reading only the first would truncate any such
 * event — and since the previous line-ending bug made whole streams arrive as
 * one "frame", reading only the first line is exactly how a 33-event response
 * became a single word.
 *
 * @returns the payload, or null for comments, keep-alives and terminators.
 */
export function sseData(frame: string): string | null {
  const payload = frame
    .split(/\r\n|\n|\r/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('\n')
    .trim()
  if (!payload || payload === '[DONE]') return null
  return payload
}
