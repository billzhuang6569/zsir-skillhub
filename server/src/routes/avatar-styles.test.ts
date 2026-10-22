import Fastify, { type FastifyInstance } from 'fastify'
import type { AvatarStyleVersion } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type StyleLookup = { where: { styleId_styleVersion: { styleId: string; styleVersion: number } } }
const state = vi.hoisted(() => ({ rows: new Map<string, AvatarStyleVersion>(), insert: vi.fn(), findMany: vi.fn() }))
vi.mock('../db.js', () => ({ db: {
  $executeRaw: state.insert,
  avatarStyleVersion: {
    findMany: state.findMany,
    findUnique: vi.fn(async ({ where }: StyleLookup): Promise<AvatarStyleVersion | null> => {
      const { styleId, styleVersion } = where.styleId_styleVersion
      return state.rows.get(`${styleId}@${styleVersion}`) ?? null
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: StyleLookup): Promise<AvatarStyleVersion> => {
      const { styleId, styleVersion } = where.styleId_styleVersion
      const row = state.rows.get(`${styleId}@${styleVersion}`)
      if (!row) throw new Error('missing fixture')
      return row
    }),
  },
} }))
vi.mock('../config.js', () => ({ config: {} }))

import { avatarStylesRoutes } from './avatar-styles.js'
import { avatarStyleCatalog, canonicalJson, classicAvatarStyle, contentSha256, type AvatarStyle } from '../lib/avatar-style-catalog.js'
import { cacheAvatarStyles, fetchAvatarStyles, startAvatarStyleSync } from '../lib/avatar-styles.js'

const origin = 'https://styles.example.test/instance'
const logger = { warn: vi.fn() }
const testStyles: AvatarStyle[] = ['test-monochrome', 'test-lines'].map(styleId => ({
  ...classicAvatarStyle, styleId, status: 'test', name: { zh: `测试：${styleId}`, en: `Test: ${styleId}` },
}))
const multiStyleCatalog = [classicAvatarStyle, ...testStyles]
let app: FastifyInstance

function seed(style: AvatarStyle): void {
  const content = canonicalJson(style)
  state.rows.set(`${style.styleId}@${style.styleVersion}`, {
    styleId: style.styleId, styleVersion: style.styleVersion, content,
    contentSha256: contentSha256(content), source: 'fetched', createdAt: new Date(),
  })
}

beforeEach(async (): Promise<void> => {
  state.rows.clear()
  vi.clearAllMocks()
  state.insert.mockReset().mockImplementation(async (
    _sql: TemplateStringsArray, styleId: string, styleVersion: number, content: string, hash: string, source: string,
  ): Promise<number> => {
    const key = `${styleId}@${styleVersion}`
    if (state.rows.has(key)) return 0
    state.rows.set(key, { styleId, styleVersion, content, contentSha256: hash, source, createdAt: new Date() })
    return 1
  })
  state.findMany.mockReset().mockImplementation(async (): Promise<AvatarStyleVersion[]> => [...state.rows.values()]
    .sort((a, b) => a.styleId.localeCompare(b.styleId) || b.styleVersion - a.styleVersion))
  app = Fastify()
  await app.register(avatarStylesRoutes, { prefix: '/api/avatar-styles' })
})
afterEach(async (): Promise<void> => {
  await app.close()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('public cached avatar style routes', () => {
  it('lists only the latest published cached version with names, descriptions and preview, without network or generation', async (): Promise<void> => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    for (const style of multiStyleCatalog) seed(style)
    seed({ ...classicAvatarStyle, styleVersion: 2, status: 'published' })
    seed({ ...classicAvatarStyle, styleVersion: 3, directPrompt: ' ' })
    seed({ ...classicAvatarStyle, styleVersion: 4, status: 'test' })
    const response = await app.inject('/api/avatar-styles')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([
      { ...classicAvatarStyle, styleVersion: 2, status: 'published' },
    ])
    expect(response.headers['cache-control']).toBe('public, max-age=300')
    expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/)
    expect(fetcher).not.toHaveBeenCalled()
    expect(state.insert).not.toHaveBeenCalled()
  })

  it('serves immutable old versions, 404 for absent/invalid versions, and no mutations', async (): Promise<void> => {
    seed(classicAvatarStyle)
    seed({ ...classicAvatarStyle, styleVersion: 2 })
    const response = await app.inject('/api/avatar-styles/classic/versions/1')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(classicAvatarStyle)
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    for (const path of ['missing/versions/1', 'classic/versions/4', 'classic/versions/0', 'classic/versions/1.5', 'classic/versions/2147483648']) {
      const missing = await app.inject(`/api/avatar-styles/${path}`)
      expect(missing.statusCode).toBe(404)
      expect(missing.headers['cache-control']).toBe('no-store')
    }
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      expect((await app.inject({ method, url: '/api/avatar-styles/classic/versions/1' })).statusCode).toBe(404)
    }
  })

  it('supports ETag/304 for both routes, weak validators, lists of tags and changed lists', async (): Promise<void> => {
    seed(classicAvatarStyle)
    let listTag: string | undefined
    for (const url of ['/api/avatar-styles', '/api/avatar-styles/classic/versions/1']) {
      const response = await app.inject(url)
      const etag = String(response.headers.etag)
      if (url === '/api/avatar-styles') listTag = etag
      expect(contentSha256(response.body)).toBe(etag.slice(1, -1))
      for (const validator of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
        const cached = await app.inject({ url, headers: { 'if-none-match': validator } })
        expect(cached.statusCode).toBe(304)
        expect(cached.body).toBe('')
        expect(cached.headers.etag).toBe(etag)
      }
      expect((await app.inject({ url, headers: { 'if-none-match': '"other"' } })).statusCode).toBe(200)
    }
    seed({ ...classicAvatarStyle, styleVersion: 2 })
    expect((await app.inject({ url: '/api/avatar-styles', headers: { 'if-none-match': listTag! } })).statusCode).toBe(200)
  })

  it('returns an empty cache initially and hides corrupt or unpaired stored entries', async (): Promise<void> => {
    expect((await app.inject('/api/avatar-styles')).json()).toEqual([])
    seed(classicAvatarStyle)
    const row = state.rows.get('classic@1')!
    row.contentSha256 = '0'.repeat(64)
    expect((await app.inject('/api/avatar-styles')).json()).toEqual([])
    expect((await app.inject('/api/avatar-styles/classic/versions/1')).statusCode).toBe(404)
    seed({ ...classicAvatarStyle, directPrompt: '' })
    expect((await app.inject('/api/avatar-styles')).json()).toEqual([])
    state.rows.get('classic@1')!.content = '{'
    expect((await app.inject('/api/avatar-styles')).json()).toEqual([])
  })

  it('does not expose database errors in responses', async (): Promise<void> => {
    state.findMany.mockRejectedValueOnce(new Error('private prompt and database details'))
    const response = await app.inject('/api/avatar-styles')
    expect(response.statusCode).toBe(503)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({ error: 'avatar_style_cache_unavailable' })
  })
})

describe('avatar style synchronization', () => {
  it('fetches through the configured path, inserts valid versions and ignores invalid/unpaired entries', async (): Promise<void> => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      ...multiStyleCatalog, { ...classicAvatarStyle, styleVersion: 2 },
      { ...classicAvatarStyle, styleId: 'unpaired', directPrompt: '' },
      { ...classicAvatarStyle, styleId: 'missing', metaPrompt: undefined },
      { privatePrompt: 'do-not-log' }, null,
    ])))
    vi.stubGlobal('fetch', request)
    await fetchAvatarStyles(origin, logger)
    expect(request).toHaveBeenCalledWith(`${origin}/api/avatar-styles`, expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }))
    expect(state.rows.size).toBe(4)
    expect([...state.rows.values()].every(row => row.source === 'fetched')).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith({ code: 'avatar_style_invalid', count: 4 }, 'Avatar style entries ignored')
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('do-not-log')
  })

  it('keeps existing content and provenance on duplicates and conflicts, including concurrent writes', async (): Promise<void> => {
    await cacheAvatarStyles([classicAvatarStyle], 'repository', logger)
    const stored = structuredClone(state.rows.get('classic@1'))
    await Promise.all([
      cacheAvatarStyles([classicAvatarStyle], 'fetched', logger),
      cacheAvatarStyles([{ ...classicAvatarStyle, directPrompt: 'private-conflicting-prompt' }], 'fetched', logger),
    ])
    expect(state.rows.get('classic@1')).toEqual(stored)
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith({ code: 'avatar_style_hash_conflict', styleId: 'classic', styleVersion: 1 }, 'Avatar style version retained')
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private-conflicting-prompt')
  })

  it('keeps serving the exact cached body and ETag after failures or a later list omitting old styles', async (): Promise<void> => {
    await cacheAvatarStyles(multiStyleCatalog, 'fetched', logger)
    const before = await app.inject('/api/avatar-styles')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(fetchAvatarStyles(origin, logger)).rejects.toThrow()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]')))
    await fetchAvatarStyles(origin, logger)
    const after = await app.inject('/api/avatar-styles')
    expect(after.body).toBe(before.body)
    expect(after.headers.etag).toBe(before.headers.etag)
    expect((await app.inject('/api/avatar-styles/classic/versions/1')).json()).toEqual(classicAvatarStyle)
  })

  it('bounds upstream bodies and rejects malformed envelopes without caching or leaking payloads', async (): Promise<void> => {
    for (const body of ['{"private-prompt":"secret"}', 'private-prompt', ' '.repeat(2 * 1024 * 1024 + 1), JSON.stringify(Array(201).fill(null))]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
      await expect(fetchAvatarStyles(origin, logger)).rejects.toThrow(/^avatar_style_response_/)
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private-prompt', { status: 503 })))
    await expect(fetchAvatarStyles(origin, logger)).rejects.toThrow('avatar_style_fetch_failed')
    expect(state.rows.size).toBe(0)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('seeds the official catalog using non-blocking startup retry and does not fetch or poll', async (): Promise<void> => {
    vi.useFakeTimers()
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    state.insert.mockRejectedValueOnce(new Error('database unavailable, private prompt'))
    const stop = startAvatarStyleSync({ SKILLHUB_PROFILE: 'yitan-official', AVATAR_STYLE_ORIGIN: origin }, logger)
    app.addHook('onClose', async (): Promise<void> => { stop() })
    await app.ready()
    await vi.advanceTimersByTimeAsync(1_000)
    expect([...state.rows.keys()]).toEqual(['classic@1'])
    expect([...state.rows.values()].map(row => JSON.parse(row.content))).toEqual(avatarStyleCatalog)
    expect([...state.rows.values()].every(row => row.source === 'repository')).toBe(true)
    expect(request).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private prompt')
  })

  it('retries failures, refreshes every 12 hours after success, resets backoff and stops on close', async (): Promise<void> => {
    vi.useFakeTimers()
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('private error 1'))
      .mockRejectedValueOnce(new Error('private error 2'))
      .mockImplementationOnce(async (): Promise<Response> => new Response(JSON.stringify(multiStyleCatalog)))
      .mockRejectedValueOnce(new Error('private error 3'))
      .mockImplementation(async (): Promise<Response> => new Response('[]'))
    vi.stubGlobal('fetch', request)
    const stop = startAvatarStyleSync({ SKILLHUB_PROFILE: 'selfhost', AVATAR_STYLE_ORIGIN: origin }, logger)
    app.addHook('onClose', async (): Promise<void> => { stop() })
    await app.ready()
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(state.rows.size).toBe(3)
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1_000 - 1)
    expect(request).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(request).toHaveBeenCalledTimes(5)
    expect(logger.warn.mock.calls).toEqual([1_000, 1_000].map(retryInMs => [
      { task: 'avatar-styles', retryInMs, code: 'avatar_style_fetch_failed' },
      'Avatar style catalog sync failed; using cached styles',
    ]))
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private error')
    await app.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('backs off to one hour, warns once per outage and returns to the 12 hour cycle', async (): Promise<void> => {
    vi.useFakeTimers()
    const request = vi.fn().mockImplementation(async (): Promise<Response> => new Response('private upstream body', { status: 404 }))
    vi.stubGlobal('fetch', request)
    const stop = startAvatarStyleSync({ SKILLHUB_PROFILE: 'selfhost', AVATAR_STYLE_ORIGIN: origin }, logger)
    app.addHook('onClose', async (): Promise<void> => { stop() })
    await app.ready()
    await vi.advanceTimersByTimeAsync(0)
    let attempts = 1
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000,
      256_000, 512_000, 1_024_000, 2_048_000, 3_600_000, 3_600_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(request).toHaveBeenCalledTimes(attempts)
      await vi.advanceTimersByTimeAsync(1)
      expect(request).toHaveBeenCalledTimes(++attempts)
    }
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { task: 'avatar-styles', retryInMs: 1_000, code: 'avatar_style_fetch_failed' },
      'Avatar style catalog sync failed; using cached styles',
    )
    request.mockImplementation(async (): Promise<Response> => new Response('[]'))
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(request).toHaveBeenCalledTimes(++attempts)
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1_000 - 1)
    expect(request).toHaveBeenCalledTimes(attempts)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(++attempts)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    await app.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never blocks readiness on an unreachable origin and cancels retries after close', async (): Promise<void> => {
    vi.useFakeTimers()
    let rejectFetch!: (error: Error) => void
    vi.stubGlobal('fetch', vi.fn((): Promise<Response> => new Promise((_resolve, reject) => { rejectFetch = reject })))
    const stop = startAvatarStyleSync({ SKILLHUB_PROFILE: 'selfhost', AVATAR_STYLE_ORIGIN: origin }, logger)
    app.addHook('onClose', async (): Promise<void> => { stop() })
    await app.ready()
    expect((await app.inject('/api/avatar-styles')).json()).toEqual([])
    await app.close()
    rejectFetch(new Error('private late error'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logger.warn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
