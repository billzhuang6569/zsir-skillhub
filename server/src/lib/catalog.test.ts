import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCatalogVerifier } from './catalog.js'

const origin = 'https://catalog.example.test/skillhub'
const source = { skillId: 'a1a1a1a1-0000-4000-8000-000000000001', version: '0.1.0', packageSha256: 'a'.repeat(64) }
const listing = { id: source.skillId, version: { version: source.version, packageSha256: source.packageSha256 } }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('official catalog metadata verification', () => {
  it('uses anonymous bounded metadata requests and caches successes for 60 seconds without extending TTL', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const fetcher = vi.fn(async (): Promise<Response> => Response.json(listing))
    vi.stubGlobal('fetch', fetcher)
    const verify = createCatalogVerifier(origin)
    await verify(source)
    vi.advanceTimersByTime(30_000)
    await verify(source)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(`${origin}/api/marketplace/${source.skillId}`, {
      redirect: 'error', signal: expect.any(AbortSignal), headers: { Accept: 'application/json' },
    })
    await expect(verify({ ...source, packageSha256: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'CATALOG_MISMATCH' })
    vi.advanceTimersByTime(30_001)
    await verify(source)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([404, 410, 429, 500, 503, 302])('maps HTTP %s without reading its body', async (status): Promise<void> => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response('private error body', { status })))
    await expect(createCatalogVerifier(origin)(source)).rejects.toMatchObject({
      code: status === 404 || status === 410 ? 'CATALOG_NOT_AVAILABLE' : 'CATALOG_UNREACHABLE',
      statusCode: status === 404 || status === 410 ? 409 : 503,
    })
  })
  it.each(['rejected', 'submitted', 'withdrawn'])('rejects explicit listing state %s', async (status): Promise<void> => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => Response.json({ ...listing, status })))
    await expect(createCatalogVerifier(origin)(source)).rejects.toMatchObject({ code: 'CATALOG_NOT_AVAILABLE' })
  })
  it('rejects withdrawal and mismatched IDs, hashes and versions', async (): Promise<void> => {
    for (const [payload, code] of [
      [{ ...listing, withdrawnAt: '2026-10-18T00:00:00Z' }, 'CATALOG_NOT_AVAILABLE'],
      [{ ...listing, id: 'b1b1b1b1-0000-4000-8000-000000000001' }, 'CATALOG_MISMATCH'],
      [{ ...listing, version: { ...listing.version, version: '0.2.0' } }, 'CATALOG_MISMATCH'],
      [{ ...listing, version: { ...listing.version, packageSha256: 'b'.repeat(64) } }, 'CATALOG_MISMATCH'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => Response.json(payload)))
      await expect(createCatalogVerifier(origin)(source)).rejects.toMatchObject({ code })
    }
  })
  it('sanitizes failures, does not cache them, and bounds streamed bodies', async (): Promise<void> => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('private upstream URL'))
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockImplementationOnce(async (): Promise<Response> => new Response('{invalid'))
      .mockImplementationOnce(async (): Promise<Response> => Response.json({ version: null }))
      .mockImplementationOnce(async (): Promise<Response> => new Response(new ReadableStream<Uint8Array>({ start(controller): void {
        controller.enqueue(new Uint8Array(128 * 1024)); controller.enqueue(new Uint8Array(128 * 1024 + 1)); controller.close()
      } })))
      .mockImplementationOnce(async (): Promise<Response> => Response.json(listing))
    vi.stubGlobal('fetch', fetcher)
    const verify = createCatalogVerifier(origin)
    for (let attempt = 0; attempt < 5; attempt++) await expect(verify(source)).rejects.toMatchObject({ code: 'CATALOG_UNREACHABLE', message: '官方商店暂时不可用，请稍后重试' })
    await verify(source)
    expect(fetcher).toHaveBeenCalledTimes(6)
  })
})
