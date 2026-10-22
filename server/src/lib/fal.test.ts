import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../config.js', () => ({ config: { FAL_KEY: 'fixture-key-no-real-secret' } }))
vi.mock('../db.js', () => ({ db: {} }))
import { falAvatarPayload, falImageUrl, findSubmittedFalAvatar, pollFalAvatar, submitFalAvatar, validateAvatarJpeg } from './fal.js'
afterEach(() => { vi.unstubAllGlobals() })

describe('FAL avatar boundary', () => {
  it('uses the exact approved payload and does not retry submission on timeout', async () => {
    expect(falAvatarPayload('drawing')).toEqual({ prompt: 'drawing', num_images: 1, aspect_ratio: '1:1',
      output_format: 'jpeg', safety_tolerance: '6', resolution: '0.5K', limit_generations: true, thinking_level: 'high' })
    const request = vi.fn().mockRejectedValue(new Error('timeout'))
    vi.stubGlobal('fetch', request)
    await expect(submitFalAvatar('drawing')).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('keeps the HTTP status and Retry-After of a refused poll without retaining the body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"detail":"private detail"}', { status: 429, headers: { 'retry-after': '90' } })))
    const error = await pollFalAvatar('11111111-1111-4111-8111-111111111111').catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: 'fal_http_429', status: 429, retryAfterMs: 90_000 })
    expect(JSON.stringify(error)).not.toContain('private detail')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })))
    await expect(pollFalAvatar('11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code: 'fal_http_500', status: 500, retryAfterMs: null })
  })
  it('checks COMPLETED errors before fetching any result image', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'COMPLETED', error: 'safety blocked' })))
    vi.stubGlobal('fetch', request)
    await expect(pollFalAvatar('11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code: 'fal_generation_failed' })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('rejects an invalid completed result and restricts downloads to official image hosts', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ images: [], error: 'failed' }))))
    await expect(pollFalAvatar('11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code: 'fal_invalid_result' })
    for (const url of ['http://v3.fal.media/x', 'https://127.0.0.1/x', 'https://fal.media.attacker.invalid/x', 'https://user:pass@v3.fal.media/x']) {
      expect(() => falImageUrl(url)).toThrow()
    }
    expect(falImageUrl('https://v3.fal.media/files/x.jpg')).toContain('v3.fal.media')
  })
  it('rejects bad image signatures and non-square JPEG dimensions', () => {
    expect(() => validateAvatarJpeg(Buffer.from('not an image'))).toThrow()
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 2, 0, 2, 0, 0xff, 0xd9])
    expect(() => validateAvatarJpeg(jpeg)).not.toThrow()
    jpeg[10] = 1
    expect(() => validateAvatarJpeg(jpeg)).toThrow()
  })
  it('reconciles only one exact payload in a complete, paginated submission window', async () => {
    const submittedAt = new Date()
    const item = { request_id: '11111111-1111-4111-8111-111111111111', endpoint_id: 'fal-ai/nano-banana-2',
      sent_at: submittedAt.toISOString(), json_input: falAvatarPayload('saved drawing') }
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ ...item, json_input: falAvatarPayload('unrelated') }], has_more: true, next_cursor: 'page2' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [item], has_more: false, next_cursor: null })))
    vi.stubGlobal('fetch', request)
    expect(await findSubmittedFalAvatar('saved drawing', submittedAt)).toBe(item.request_id)
    expect(new URL(request.mock.calls[1][0]).searchParams.get('cursor')).toBe('page2')
    expect(request.mock.calls.every(call => !call[1].method || call[1].method === 'GET')).toBe(true)
  })
  it('keeps zero, multiple, incomplete or inaccessible provider matches quarantined', async () => {
    const submittedAt = new Date()
    const item = { request_id: '11111111-1111-4111-8111-111111111111', endpoint_id: 'fal-ai/nano-banana-2',
      sent_at: submittedAt.toISOString(), json_input: falAvatarPayload('same') }
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [], has_more: false, next_cursor: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [item, { ...item, request_id: '22222222-2222-4222-8222-222222222222' }], has_more: false, next_cursor: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [item], has_more: true, next_cursor: null })))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', request)
    expect(await findSubmittedFalAvatar('same', submittedAt)).toBeNull()
    expect(await findSubmittedFalAvatar('same', submittedAt)).toBeNull()
    await expect(findSubmittedFalAvatar('same', submittedAt)).rejects.toMatchObject({ code: 'fal_history_incomplete' })
    await expect(findSubmittedFalAvatar('same', submittedAt)).rejects.toMatchObject({ code: 'fal_history_http_403' })
  })
})
