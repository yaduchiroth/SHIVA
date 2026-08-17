import { expect, test } from '@playwright/test'
import { SseFramer, sseData } from '@/lib/sse'

/**
 * SSE framing.
 *
 * These exist because the bug they cover was written twice and shipped once: a
 * reader that splits on the blank-line separator and keeps the tail as
 * "incomplete" will silently discard the final frame, because the final frame
 * has no trailing separator. When a short reply arrives as one chunk, the
 * entire response is that final frame — so the request succeeds, the buffer
 * holds the whole answer, and the parser reports nothing at all.
 */

test.describe('SseFramer', () => {
  test('emits complete frames as they arrive', () => {
    const framer = new SseFramer()
    expect(framer.push('data: {"a":1}\n\ndata: {"a":2}\n\n')).toEqual([
      'data: {"a":1}',
      'data: {"a":2}',
    ])
  })

  test('holds back a partial frame until it completes', () => {
    const framer = new SseFramer()
    // A chunk boundary mid-JSON must not produce a truncated frame.
    expect(framer.push('data: {"hal')).toEqual([])
    expect(framer.push('f":true}\n\n')).toEqual(['data: {"half":true}'])
  })

  test('flush returns the final frame, which has no trailing separator', () => {
    const framer = new SseFramer()
    expect(framer.push('data: {"last":true}')).toEqual([])
    // Precisely the case that was being dropped.
    expect(framer.flush()).toEqual(['data: {"last":true}'])
  })

  test('a whole response arriving in one chunk is not lost', () => {
    // The exact shape of the production failure: one chunk, no trailing blank
    // line, everything in the tail.
    const framer = new SseFramer()
    const body = 'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}'
    expect(framer.push(body)).toEqual([])
    expect(framer.flush()).toEqual([body])
  })

  test('flush is empty when the stream ended cleanly', () => {
    const framer = new SseFramer()
    framer.push('data: {"a":1}\n\n')
    // No double-delivery of an already-emitted frame.
    expect(framer.flush()).toEqual([])
  })

  test('flush drains only once', () => {
    const framer = new SseFramer()
    framer.push('data: {"x":1}')
    expect(framer.flush()).toHaveLength(1)
    expect(framer.flush()).toEqual([])
  })
})

test.describe('sseData', () => {
  test('extracts the payload', () => {
    expect(sseData('data: {"a":1}')).toBe('{"a":1}')
  })

  test('ignores comments, keep-alives and terminators', () => {
    // All three are legal SSE traffic that carries no event.
    expect(sseData(': keep-alive')).toBeNull()
    expect(sseData('event: ping')).toBeNull()
    expect(sseData('data: [DONE]')).toBeNull()
    expect(sseData('data:')).toBeNull()
  })

  test('finds the data line among other fields', () => {
    expect(sseData('id: 7\nevent: message\ndata: {"ok":true}')).toBe('{"ok":true}')
  })
})
