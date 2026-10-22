import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mediaAsset = vi.hoisted(() => ({ upsert: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() }))
vi.mock('../db.js', () => ({ db: { mediaAsset } }))
vi.mock('../config.js', () => ({ config: { PICEM_BASE_URL: 'https://picem.whatonearth.work', PICEM_API_KEY: 'test-key-never-shipped' } }))
import { authorizeMediaUrl, isRetiredMedia, readPrivateMedia, removeMedia, uploadMedia } from './picem-media.js'

describe('Picem boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); mediaAsset.upsert.mockResolvedValue({}); mediaAsset.update.mockResolvedValue({}) })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('rejects retired URLs, CDN aliases and other users assets', async () => {
    expect(isRetiredMedia('https://pictshare.whatonearth.work./a.jpg')).toBe(true)
    await expect(authorizeMediaUrl('https://pictshare.whatonearth.work/a.jpg', 'owner')).rejects.toMatchObject({ statusCode: 426 })
    await expect(authorizeMediaUrl('https://picem-media.whatonearth.work./apps/app/ast/a.jpg', 'other')).rejects.toMatchObject({ statusCode: 502 })
    mediaAsset.findUnique.mockResolvedValue({ uploadedById: 'owner', visibility: 'public' })
    const url = 'https://picem-media.whatonearth.work/apps/app/ast/a.jpg'
    await expect(authorizeMediaUrl(url, 'other')).rejects.toMatchObject({ statusCode: 403 })
    await expect(authorizeMediaUrl(url, 'owner')).resolves.toBeUndefined()
  })

  it('persists accepted asset IDs before polling and repeats the same upload key after timeout', async () => {
    const calls: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
      calls.push(init)
      if (init.method === 'POST') return Response.json({ id: 'ast_pending', status: 'processing' }, { status: 202 })
      throw new Error('network failure')
    }))
    const options = { purpose: 'avatar' as const, visibility: 'public' as const, ownerRef: 'user:owner', userId: 'owner' }
    vi.useFakeTimers()
    const attempt = async (): Promise<void> => {
      const result = expect(uploadMedia(Buffer.from('bytes'), 'image/png', 'avatar.png', options)).rejects.toMatchObject({ statusCode: 503 })
      await vi.runAllTimersAsync(); await result
    }
    await attempt(); await attempt()
    expect(mediaAsset.update).toHaveBeenCalledWith({ where: { id: expect.any(String) }, data: { assetId: 'ast_pending', status: 'processing' } })
    expect(calls[0]?.headers).toEqual(calls[2]?.headers)
    expect(String(calls[0]?.body)).not.toContain('test-key')
  })

  it('keeps deletion recovery records until upstream confirms deletion', async () => {
    mediaAsset.findMany.mockResolvedValue([{ id: 'operation', assetId: 'ast_private' }])
    const response = vi.fn().mockResolvedValueOnce(Response.json({ status: 'deleting' }, { status: 202 })).mockResolvedValueOnce(Response.json({ id: 'ast_private', status: 'deleted' }))
    vi.stubGlobal('fetch', response)
    await removeMedia('feedback:failed')
    expect(mediaAsset.update.mock.calls.at(-1)?.[0]).toEqual({ where: { id: 'operation' }, data: { status: 'deleted', url: null } })
    expect(response).toHaveBeenCalledTimes(2)
  })

  it('does not request a private link without matching feedback ownership', async () => {
    mediaAsset.findUnique.mockResolvedValue({ ownerRef: 'feedback:one', visibility: 'private' })
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(readPrivateMedia('ast_private', 'feedback:two', 100)).rejects.toMatchObject({ statusCode: 404 })
    expect(fetch).not.toHaveBeenCalled()
  })
})
