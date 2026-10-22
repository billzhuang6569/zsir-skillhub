import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sensible from '@fastify/sensible'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = vi.hoisted(() => ({ FEEDBACK_ATTEMPTS_PER_HOUR: 2, FEEDBACK_ASSET_DIR: '' }))
const media = vi.hoisted(() => ({ uploadMedia: vi.fn(), readPrivateMedia: vi.fn(), removeMedia: vi.fn() }))
vi.mock('../lib/media.js', async (original) => ({ ...await original<typeof import('../lib/media.js')>(), ...media }))
const mockDb = vi.hoisted(() => ({
  feedback: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}))

vi.mock('../config.js', () => ({ config: mockConfig }))
vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../middleware/auth.js', () => ({
  optionalAuthMiddleware: async (request: FastifyRequest): Promise<void> => {
    if (!request.headers.authorization) return
    const userId = typeof request.headers['x-test-user-id'] === 'string'
      ? request.headers['x-test-user-id']
      : 'user-001'
    request.verifiedAuthToken = { sub: userId, ver: 0 }
    request.user = { id: userId, email: 'user@example.com', displayName: '用户', marketplaceRole: 'user' }
  },
  authMiddleware: async (request: FastifyRequest): Promise<void> => {
    const admin = request.headers['x-test-role'] === 'admin'
    const requestedUserId = typeof request.headers['x-test-user-id'] === 'string'
      ? request.headers['x-test-user-id']
      : undefined
    request.user = { id: requestedUserId ?? (admin ? 'admin-001' : 'user-001'), email: 'user@example.com', displayName: '用户', marketplaceRole: admin ? 'admin' : 'user' }
  },
}))

import { feedbackRoutes } from './feedback.js'

const FEEDBACK_ID = '11111111-1111-4111-8111-111111111111'
const OPERATION_ID = '22222222-2222-4222-8222-222222222222'

type StoredOperation = {
  id: string
  status: string
  createdAt: Date
  requestDigest: string | null
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify()
  await app.register(sensible)
  await app.register(feedbackRoutes, { prefix: '/api/feedback' })
  await app.ready()
  return app
}

describe('feedback routes', () => {
  let app: FastifyInstance | undefined
  let assetDir = ''
  let operations = new Map<string, StoredOperation>()

  beforeEach(async () => {
    vi.clearAllMocks()
    let operationQueue: Promise<unknown> = Promise.resolve()
    mockDb.$transaction.mockImplementation((callback: (tx: { $executeRaw: ReturnType<typeof vi.fn> }) => Promise<unknown>) => {
      const operation = operationQueue.then(() => callback({ $executeRaw: vi.fn() }))
      operationQueue = operation.catch(() => undefined)
      return operation
    })
    assetDir = await mkdtemp(join(tmpdir(), 'skillhub-feedback-route-'))
    mockConfig.FEEDBACK_ASSET_DIR = assetDir
    mockConfig.FEEDBACK_ATTEMPTS_PER_HOUR = 2
    operations = new Map()
    mockDb.feedback.findUnique.mockImplementation(async ({ where }: {
      where: {
        operationScopeHash_clientOperationId?: {
          operationScopeHash: string
          clientOperationId: string
        }
      }
    }) => {
      const operation = where.operationScopeHash_clientOperationId
      return operation
        ? operations.get(`${operation.operationScopeHash}:${operation.clientOperationId}`) ?? null
        : null
    })
    mockDb.feedback.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const created = {
        id: String(data.id ?? FEEDBACK_ID),
        status: 'pending',
        createdAt: new Date('2026-08-13T08:00:00.000Z'),
        requestDigest: typeof data.requestDigest === 'string' ? data.requestDigest : null,
      }
      if (
        typeof data.operationScopeHash === 'string'
        && typeof data.clientOperationId === 'string'
      ) {
        const key = `${data.operationScopeHash}:${data.clientOperationId}`
        if (operations.has(key)) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' })
        operations.set(key, created)
      }
      return created
    })
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    await rm(assetDir, { recursive: true, force: true })
  })

  it('accepts guest feedback and associates only a verified account', async () => {
    app = await buildApp()
    const guest = await app.inject({ method: 'POST', url: '/api/feedback', payload: { type: 'usage', content: '  这里不好理解  ' } })
    expect(guest.statusCode).toBe(201)
    expect(mockDb.feedback.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ userId: null, content: '这里不好理解' }) }))

    const signedIn = await app.inject({ method: 'POST', url: '/api/feedback', headers: { authorization: 'Bearer valid' }, payload: { type: 'bug', content: '无法导入', contact: 'bill@example.com' } })
    expect(signedIn.statusCode).toBe(201)
    expect(mockDb.feedback.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ userId: 'user-001', contact: 'bill@example.com' }) }))
    expect(guest.json<Record<string, unknown>>()).not.toHaveProperty('content')
    expect(signedIn.json<Record<string, unknown>>()).not.toHaveProperty('contact')
  })

  it('replays one authenticated operation before rate limiting and rejects payload drift', async () => {
    mockConfig.FEEDBACK_ATTEMPTS_PER_HOUR = 1
    app = await buildApp()
    const headers = { authorization: 'Bearer valid' }
    const payload = {
      type: 'bug',
      content: '  无法同步  ',
      contact: 'bill@example.com',
      clientOperationId: OPERATION_ID,
      diagnostics: {
        schemaVersion: 1,
        source: 'skillhub-cli',
        appVersion: '0.12.0',
        platform: 'darwin',
        architecture: 'aarch64',
      },
    }

    const created = await app.inject({ method: 'POST', url: '/api/feedback', headers, payload })
    expect(created.statusCode).toBe(201)
    expect(created.headers['cache-control']).toBe('private, no-store')
    const replayed = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers,
      payload: { ...payload, content: '无法同步' },
    })
    expect(replayed.statusCode).toBe(200)
    expect(replayed.json()).toEqual(created.json())
    expect(mockDb.feedback.create).toHaveBeenCalledTimes(1)

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers,
      payload: { ...payload, content: '另一个问题' },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json()).toEqual({
      code: 'FEEDBACK_OPERATION_CONFLICT',
      error: 'Feedback operation conflict',
    })
    const diagnosticsConflict = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers,
      payload: {
        ...payload,
        diagnostics: { ...payload.diagnostics, appVersion: '0.12.1' },
      },
    })
    expect(diagnosticsConflict.statusCode).toBe(409)

    const limited = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers,
      payload: { ...payload, clientOperationId: '33333333-3333-4333-8333-333333333333' },
    })
    expect(limited.statusCode).toBe(429)
  })

  it('recovers a concurrent first-write unique conflict as the same operation result', async () => {
    mockConfig.FEEDBACK_ATTEMPTS_PER_HOUR = 10
    let racedOperation: StoredOperation | null = null
    mockDb.feedback.findUnique.mockImplementation(async ({ where }: {
      where: { operationScopeHash_clientOperationId?: unknown }
    }) => where.operationScopeHash_clientOperationId ? racedOperation : null)
    mockDb.feedback.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      racedOperation = {
        id: FEEDBACK_ID,
        status: 'pending',
        createdAt: new Date('2026-08-13T08:00:00.000Z'),
        requestDigest: String(data.requestDigest),
      }
      throw Object.assign(new Error('Unique constraint'), { code: 'P2002' })
    })
    app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { authorization: 'Bearer valid' },
      payload: { type: 'feature', content: '增加批量操作', clientOperationId: OPERATION_ID },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      id: FEEDBACK_ID,
      status: 'pending',
      createdAt: '2026-08-13T08:00:00.000Z',
    })
  })

  it('queries operation results only inside the authenticated or guest identity scope', async () => {
    mockConfig.FEEDBACK_ATTEMPTS_PER_HOUR = 10
    app = await buildApp()
    const payload = { type: 'usage', content: '需要帮助', clientOperationId: OPERATION_ID }
    const signedHeaders = { authorization: 'Bearer valid', 'x-test-user-id': 'user-001' }
    const created = await app.inject({ method: 'POST', url: '/api/feedback', headers: signedHeaders, payload })
    expect(created.statusCode).toBe(201)

    const operationPath = `/api/feedback/operations/${OPERATION_ID}`
    const sameUser = await app.inject({ method: 'GET', url: operationPath, headers: signedHeaders })
    expect(sameUser.statusCode).toBe(200)
    expect(sameUser.headers['cache-control']).toBe('private, no-store')
    expect(sameUser.json()).toEqual(created.json())
    expect(Object.keys(sameUser.json<Record<string, unknown>>()).sort()).toEqual(['createdAt', 'id', 'status'])

    const otherUser = await app.inject({
      method: 'GET',
      url: operationPath,
      headers: { authorization: 'Bearer valid', 'x-test-user-id': 'user-002' },
    })
    expect(otherUser.statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: operationPath })).statusCode).toBe(404)

    const guestOperationId = '44444444-4444-4444-8444-444444444444'
    const guestHeaders = { 'user-agent': 'skillhub-cli/test-a' }
    const guest = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: guestHeaders,
      payload: { ...payload, clientOperationId: guestOperationId },
    })
    expect(guest.statusCode).toBe(201)
    const guestPath = `/api/feedback/operations/${guestOperationId}`
    expect((await app.inject({ method: 'GET', url: guestPath, headers: guestHeaders })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: guestPath, headers: { 'user-agent': 'other-client' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: guestPath, headers: signedHeaders })).statusCode).toBe(404)

    const stableOperationId = '55555555-5555-4555-8555-555555555555'
    const stableScope = 'a'.repeat(64)
    const stableGuest = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { 'user-agent': 'first-network', 'x-skillhub-feedback-guest-scope': stableScope },
      payload: { ...payload, clientOperationId: stableOperationId },
    })
    expect(stableGuest.statusCode).toBe(201)
    const stablePath = `/api/feedback/operations/${stableOperationId}`
    expect((await app.inject({
      method: 'GET',
      url: stablePath,
      headers: { 'user-agent': 'second-network', 'x-skillhub-feedback-guest-scope': stableScope },
    })).statusCode).toBe(200)
    expect((await app.inject({
      method: 'GET',
      url: stablePath,
      headers: { 'user-agent': 'second-network', 'x-skillhub-feedback-guest-scope': 'b'.repeat(64) },
    })).statusCode).toBe(404)
  })

  it('accepts only bounded CLI diagnostics and never returns operation internals', async () => {
    mockConfig.FEEDBACK_ATTEMPTS_PER_HOUR = 10
    app = await buildApp()
    const diagnostics = {
      schemaVersion: 1,
      source: 'skillhub-cli',
      appVersion: '0.12.0',
      platform: 'windows',
      architecture: 'x86_64',
    }
    const created = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: { type: 'bug', content: '启动失败', clientOperationId: OPERATION_ID, diagnostics },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json<Record<string, unknown>>()).toEqual(expect.objectContaining({ status: 'pending' }))
    expect(created.json<Record<string, unknown>>()).not.toHaveProperty('diagnostics')
    expect(created.json<Record<string, unknown>>()).not.toHaveProperty('clientOperationId')
    expect(created.json<Record<string, unknown>>()).not.toHaveProperty('operationScopeHash')
    expect(created.json<Record<string, unknown>>()).not.toHaveProperty('requestDigest')
    expect(mockDb.feedback.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ diagnostics, clientOperationId: OPERATION_ID }),
    }))

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      payload: {
        type: 'bug',
        content: '启动失败',
        diagnostics: { ...diagnostics, secret: 'must-not-be-accepted' },
      },
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('validates fields and rate limits submissions by IP', async () => {
    app = await buildApp()
    expect((await app.inject({ method: 'POST', url: '/api/feedback', payload: { type: 'unknown', content: 'x' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/feedback', payload: { type: 'usage', content: 'x' } })).statusCode).toBe(201)
    const limited = await app.inject({ method: 'POST', url: '/api/feedback', payload: { type: 'usage', content: 'x' } })
    expect(limited.statusCode).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('serializes attachment retries under one stable operation and preserves the successful submission', async () => {
    app = await buildApp()
    media.uploadMedia.mockResolvedValue({ assetId: 'ast_private', url: null })
    const payload = { type: 'bug', content: 'retry', clientOperationId: OPERATION_ID,
      attachments: [{ fileName: 'screen.png', mimeType: 'image/png', dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64') }] }
    const responses = await Promise.all([1, 2].map(() => app!.inject({ method: 'POST', url: '/api/feedback', headers: { authorization: 'Bearer test' }, payload })))
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 201])
    expect(responses[0]!.json().id).toBe(responses[1]!.json().id)
    expect(media.uploadMedia).toHaveBeenCalledOnce()
    expect(media.removeMedia).not.toHaveBeenCalled()
  })

  it('stores validated private images and serves them only to administrators', async () => {
    app = await buildApp()
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    media.uploadMedia.mockResolvedValue({ assetId: 'ast_private', url: null })
    media.readPrivateMedia.mockResolvedValue(image)
    const created = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { authorization: 'Bearer test' },
      payload: {
        type: 'bug',
        content: '界面异常',
        attachments: [{ fileName: 'screen.png', mimeType: 'image/png', dataBase64: image.toString('base64') }],
      },
    })
    expect(created.statusCode).toBe(201)
    const createInput = mockDb.feedback.create.mock.calls[0]?.[0] as { data: { attachments: { id: string }[] } }
    const attachment = createInput.data.attachments[0]
    expect(attachment?.id).toMatch(/^[0-9a-f-]{36}$/)
    mockDb.feedback.findUnique.mockResolvedValue({ attachments: createInput.data.attachments })

    const feedbackId = created.json<{ id: string }>().id
    const path = `/api/feedback/${feedbackId}/attachments/${attachment?.id}`
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(403)
    const response = await app.inject({ method: 'GET', url: path, headers: { 'x-test-role': 'admin' } })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('image/png')
    expect(response.rawPayload.equals(image)).toBe(true)
  })

  it('lets only administrators list feedback and change the bounded status', async () => {
    mockDb.feedback.findMany.mockResolvedValue([{ id: FEEDBACK_ID, status: 'pending' }])
    mockDb.feedback.findUnique.mockResolvedValue({ id: FEEDBACK_ID })
    mockDb.feedback.update.mockResolvedValue({ id: FEEDBACK_ID, status: 'resolved' })
    app = await buildApp()

    expect((await app.inject({ method: 'GET', url: '/api/feedback' })).statusCode).toBe(403)
    const list = await app.inject({ method: 'GET', url: '/api/feedback?status=pending', headers: { 'x-test-role': 'admin' } })
    expect(list.statusCode).toBe(200)
    expect(mockDb.feedback.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'pending' }, take: 100 }))
    const listInput = mockDb.feedback.findMany.mock.calls[0]?.[0] as { select: Record<string, unknown> }
    expect(listInput.select).toEqual(expect.objectContaining({ diagnostics: true, content: true, attachments: true }))
    expect(listInput.select).not.toHaveProperty('operationScopeHash')
    expect(listInput.select).not.toHaveProperty('requestDigest')
    const updated = await app.inject({ method: 'PATCH', url: `/api/feedback/${FEEDBACK_ID}`, headers: { 'x-test-role': 'admin' }, payload: { status: 'resolved' } })
    expect(updated.statusCode).toBe(200)
    expect((await app.inject({ method: 'PATCH', url: `/api/feedback/${FEEDBACK_ID}`, headers: { 'x-test-role': 'admin' }, payload: { status: 'closed' } })).statusCode).toBe(400)
  })
})
