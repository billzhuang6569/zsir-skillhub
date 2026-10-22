import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ObjectMissingError } from '../providers/object-storage.js'

const mock = vi.hoisted(() => ({
  mediaAsset: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  user: { update: vi.fn() },
  storage: { provider: 'filesystem', get: vi.fn(), head: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))
vi.mock('../db.js', () => ({ db: mock }))
vi.mock('../config.js', async (): Promise<unknown> => {
  const { configSchema } = await import('../config-schema.js')
  return { config: configSchema.parse({ ...process.env, SKILLHUB_PROFILE: 'selfhost' }) }
})
vi.mock('../providers/filesystem-object-storage.js', () => ({ createFilesystemObjectStorage: () => mock.storage }))
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: FastifyRequest): Promise<void> => {
    request.user = { id: 'owner', displayName: 'Owner', email: 'owner@example.test' }
  },
}))

import { publicMediaRoutes } from './public-media.js'
import { mediaRoutes } from './media.js'
import { authRoutes } from './auth.js'
import { CreateTeamBody } from './teams.js'

const id = 'a'.repeat(64)
const key = `aa/${id}.png`
const url = `/media/${key}`
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const row = { id, assetId: id, uploadedById: 'owner', visibility: 'public', status: 'ready', url,
  storageKey: key, storageProvider: 'filesystem', storageNamespace: null, mimeType: 'image/png' }
let app: FastifyInstance

beforeEach(async (): Promise<void> => {
  vi.resetAllMocks()
  mock.mediaAsset.findUnique.mockResolvedValue(row)
  mock.mediaAsset.upsert.mockImplementation(async input => input.create)
  mock.storage.get.mockResolvedValue(bytes)
  app = Fastify()
  await app.register(sensible)
  await app.register(publicMediaRoutes)
  await app.register(mediaRoutes, { prefix: '/api/media' })
  await app.register(authRoutes, { prefix: '/api/auth' })
})
afterEach(async (): Promise<void> => { await app.close() })

describe('selfhost media routes', () => {
  it('serves only ready public bytes with the stored MIME and immutable/security headers outside /api', async (): Promise<void> => {
    const response = await app.inject({ url })
    expect(response.statusCode).toBe(200)
    expect(response.rawPayload).toEqual(bytes)
    expect(response.headers).toMatchObject({
      'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'",
    })
    expect((await app.inject({ url: `/api${url}` })).statusCode).toBe(404)
  })

  it.each([null, { ...row, visibility: 'private' }, { ...row, status: 'uploading' }, { ...row, status: 'deleted' },
    { ...row, storageKey: 'other' }, { ...row, mimeType: null }])('hides unknown, private or unavailable records (%j)', async (asset): Promise<void> => {
    mock.mediaAsset.findUnique.mockResolvedValue(asset)
    const response = await app.inject({ url })
    expect(response.statusCode).toBe(404)
    expect(response.headers['cache-control']).toBeUndefined()
    expect(mock.storage.get).not.toHaveBeenCalled()
  })

  it('returns 503 without caching when a stored namespace is not configured', async () => {
    for (const storageProvider of ['s3', null]) {
      mock.mediaAsset.findUnique.mockResolvedValue({ ...row, storageProvider, storageNamespace: 's3:unconfigured' })
      const response = await app.inject({ url })
      expect(response.statusCode).toBe(503)
      expect(response.headers['cache-control']).toBeUndefined()
      expect(mock.storage.get).not.toHaveBeenCalled()
    }
  })

  it.each(['/media/aa/not-a-digest.png', `/media/bb/${id}.png`, `/media/aa/${id}.svg`, `/media/aa/${id}.png%0a`,
    `/media/aa/${id}.png%2fsecret`, '/media/aa/%2e%2e'])('rejects invalid key %s before lookup', async (value): Promise<void> => {
    expect((await app.inject({ url: value })).statusCode).toBe(404)
    expect(mock.mediaAsset.findUnique).not.toHaveBeenCalled()
    expect(mock.storage.get).not.toHaveBeenCalled()
  })

  it('maps confirmed missing bytes to 404 but leaves I/O failures as errors', async (): Promise<void> => {
    mock.storage.get.mockRejectedValueOnce(new ObjectMissingError())
    expect((await app.inject({ url })).statusCode).toBe(404)
    mock.storage.get.mockRejectedValueOnce(new Error('EACCES'))
    expect((await app.inject({ url })).statusCode).toBe(500)
  })

  it('uploads validated avatars and lets the owner save the resulting relative URL', async (): Promise<void> => {
    const uploaded = await app.inject({ method: 'POST', url: '/api/media/avatars', payload: { mimeType: 'image/png', dataBase64: bytes.toString('base64') } })
    expect(uploaded.statusCode).toBe(201)
    const asset = uploaded.json<{ assetId: string; url: string }>()
    expect(asset.url).toMatch(/^\/media\/[a-f0-9]{2}\/[a-f0-9]{64}\.png$/)
    expect(mock.storage.put).toHaveBeenCalledWith(asset.url.slice('/media/'.length), bytes)
    mock.mediaAsset.findUnique.mockResolvedValue({ ...row, ...asset })
    mock.user.update.mockResolvedValue({ id: 'owner', email: 'owner@example.test', displayName: 'Owner', avatarUrl: asset.url })
    const saved = await app.inject({ method: 'PATCH', url: '/api/auth/profile', payload: { avatarUrl: asset.url } })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().user.avatarUrl).toBe(asset.url)
    expect(CreateTeamBody.safeParse({ name: 'Team', avatarUrl: asset.url }).success).toBe(true)
    mock.mediaAsset.findUnique.mockResolvedValue({ ...row, uploadedById: 'other' })
    expect((await app.inject({ method: 'PATCH', url: '/api/auth/profile', payload: { avatarUrl: asset.url } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: '/api/auth/profile', payload: { avatarUrl: `https://host.test${asset.url}` } })).statusCode).toBe(400)
    expect(CreateTeamBody.safeParse({ name: 'Team', avatarUrl: `https://host.test${asset.url}` }).success).toBe(false)
  })

  it('rejects invalid image bytes before storing anything', async (): Promise<void> => {
    const response = await app.inject({ method: 'POST', url: '/api/media/avatars', payload: { mimeType: 'image/png', dataBase64: Buffer.from('not png').toString('base64') } })
    expect(response.statusCode).toBe(400)
    expect(mock.mediaAsset.upsert).not.toHaveBeenCalled()
    expect(mock.storage.put).not.toHaveBeenCalled()
  })
})
