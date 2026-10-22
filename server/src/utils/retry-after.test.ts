import { describe, expect, it } from 'vitest'
import { AiProviderHttpError, aiProviderHttpError, readAiProviderHttpError, parseRetryAfterMs } from './retry-after.js'

describe('Retry-After parsing shared by the upstream adapters', () => {
  it('keeps the HTTP failure for malformed, oversized and unrecognized bodies', async () => {
    for (const body of ['not json', 'x'.repeat(8193), '{"error":{"code":"secret-token"}}']) {
      const error = await readAiProviderHttpError('openai-responses', new Response(body, { status: 403 }))
      expect(error).toMatchObject({ status: 403, upstreamCode: null })
      expect(JSON.stringify(error)).not.toContain(body)
    }
  })
  it('cancels oversized streaming bodies without reading the remainder', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller): void { controller.enqueue(new Uint8Array(8193)) },
      cancel(): void { cancelled = true },
    })
    expect(await readAiProviderHttpError('openai-responses', new Response(body, { status: 403 })))
      .toMatchObject({ status: 403, upstreamCode: null })
    expect(cancelled).toBe(true)
  })
  it('accepts delta-seconds and HTTP-date, and treats anything else as no stated wait', () => {
    const now = (): number => Date.parse('2026-10-10T03:37:00Z')
    expect(parseRetryAfterMs('120', now)).toBe(120_000)
    expect(parseRetryAfterMs(' 5 ', now)).toBe(5_000)
    expect(parseRetryAfterMs('Fri, 10 Oct 2026 03:42:00 GMT', now)).toBe(300_000)
    expect(parseRetryAfterMs('Fri, 10 Oct 2026 03:00:00 GMT', now)).toBe(0) // past date → no extra wait, not null
    for (const invalid of [null, undefined, '', 'soon', '-5', '1e3', '12.5']) expect(parseRetryAfterMs(invalid, now)).toBeNull()
  })
  it('builds a provider error from a Response keeping only status and wait', () => {
    const response = new Response('{"error":{"message":"secret body"}}', { status: 429, headers: { 'retry-after': '300', 'x-request-id': 'r1' } })
    const error = aiProviderHttpError('openai-responses', response)
    expect(error).toBeInstanceOf(AiProviderHttpError)
    expect(error).toMatchObject({ status: 429, retryAfterMs: 300_000, provider: 'openai-responses', message: 'AI provider returned HTTP 429' })
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain('secret body')
    expect(aiProviderHttpError('anthropic', new Response(null, { status: 503 }))).toMatchObject({ status: 503, retryAfterMs: null })
  })
})
