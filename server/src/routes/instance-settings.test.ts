import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { Prisma, type ServerSetting } from '@prisma/client'
import { randomBytes } from 'node:crypto'
import { ZodError } from 'zod'
import jwt from '@fastify/jwt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockDb = vi.hoisted(() => ({ serverSetting: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  user: { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  aiDailyUsage: { findUnique: vi.fn() }, $transaction: vi.fn(), $executeRaw: vi.fn() }))
const provider = vi.hoisted(() => vi.fn())
vi.mock('../lib/ai-http.js', async importOriginal => ({ ...await importOriginal<typeof import('../lib/ai-http.js')>(), aiJsonRequest: provider }))
vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../lib/avatar-jobs.js', async original => ({ ...await original<typeof import('../lib/avatar-jobs.js')>(),
  resolveAccountAvatarStyle: async (): Promise<object> => ({ style: { fal: { meta: { model: 'fal-ai/nano-banana-2' } } } }),
}))
vi.mock('../config.js', async () => {
  const { configSchema } = await import('../config-schema.js')
  return { config: configSchema.parse(process.env) }
})
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.headers.authorization) return reply.code(401).send({ error: 'Unauthorized' })
    request.user = { id: 'admin-1', email: 'admin@example.test', displayName: 'Admin',
      marketplaceRole: request.headers.authorization === 'Bearer admin' ? 'admin' : 'user' }
  },
}))

import { config } from '../config.js'
import { effectiveSource, getSettingSecret, getSettingValue, loadServerSettings, maskedSetting, writeServerSetting } from '../lib/server-settings.js'
import { publicServiceInfo } from '../server-info.js'
import { instanceSettingsRoutes } from './instance-settings.js'
import { instanceAiStatusRoutes } from './instance-ai.js'
import { authRoutes } from './auth.js'

const aiValue = { protocol: 'openai', baseUrl: 'https://ai.example.test/v1', model: 'test-model' }
const secret = 'test-api-secret-1234'
const url = '/api/instance/settings'
const headers = { authorization: 'Bearer admin' }
const originalConfig = {
  ...config, AI_API_BASE_URL: config.AI_API_BASE_URL, AI_API_KEY: config.AI_API_KEY,
  FAL_KEY: config.FAL_KEY, CREDENTIAL_KEK_BASE64: config.CREDENTIAL_KEK_BASE64,
}

describe('instance settings', () => {
  let app: FastifyInstance
  let rows: Map<string, ServerSetting>
  let logs = ''
  beforeEach(async (): Promise<void> => {
    vi.resetAllMocks()
    mockDb.aiDailyUsage.findUnique.mockResolvedValue(null)
    mockDb.$transaction.mockImplementation(async (operation: (transaction: typeof mockDb) => Promise<unknown>): Promise<unknown> => operation(mockDb))
    logs = ''
    provider.mockResolvedValue({ choices: [{ message: { content: '{"ok":true}' } }] })
    Object.assign(config, originalConfig, {
      SKILLHUB_PROFILE: 'selfhost', AI_API_BASE_URL: undefined, AI_API_KEY: undefined, FAL_KEY: undefined,
      CREDENTIAL_KEK_BASE64: randomBytes(32).toString('base64'), CREDENTIAL_KEK_VERSION: 1, CREDENTIAL_KEK_KEYRING_JSON: {},
    })
    rows = new Map()
    mockDb.serverSetting.findMany.mockImplementation(async (): Promise<ServerSetting[]> => [...rows.values()])
    mockDb.serverSetting.upsert.mockImplementation(async ({ where, create, update }: {
      where: { key: string }; create: ServerSetting
      update: Omit<Partial<ServerSetting>, 'version'> & { version: { increment: number } }
    }): Promise<ServerSetting> => {
      const previous = rows.get(where.key)
      const row: ServerSetting = previous
        ? { ...previous, ...update, version: previous.version + update.version.increment, updatedAt: new Date() }
        : { secretCiphertext: null, secretIv: null, secretTag: null, secretWrappedDek: null,
          secretWrapIv: null, secretWrapTag: null, secretKekVersion: null, secretAadVersion: null, secretLast4: null,
          ...create, value: (create.value as unknown) === Prisma.JsonNull ? null : create.value, version: 1, updatedAt: new Date() }
      rows.set(where.key, row)
      return row
    })
    mockDb.serverSetting.deleteMany.mockImplementation(async ({ where }: { where: { key: string } }): Promise<{ count: number }> => ({ count: rows.delete(where.key) ? 1 : 0 }))
    await loadServerSettings()
    app = Fastify({ logger: { stream: { write: (chunk: string): void => { logs += chunk } } } })
    await app.register(instanceSettingsRoutes, { prefix: url })
    await app.register(instanceAiStatusRoutes, { prefix: '/api/instance' })
  })
  afterEach(async (): Promise<void> => {
    Object.assign(config, originalConfig)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    await app.close()
  })

  // Encryption/storage tests exercise the internal writer; public AI writes now require a tested draft (#403).
  async function put(key: string, payload: object): Promise<{ statusCode: number; body: string; json: () => Record<string, unknown> }> {
    if (key === 'ai' || key === 'fal') {
      try {
        await writeServerSetting(key, payload, 'admin-1')
        const value = maskedSetting(key)
        return { statusCode: 200, body: JSON.stringify(value), json: () => value }
      } catch (error: unknown) {
        const value = { error: error instanceof ZodError ? 'Invalid server setting' : 'Unable to save: CREDENTIAL_KEK_BASE64' }
        return { statusCode: error instanceof ZodError ? 400 : 503, body: JSON.stringify(value), json: () => value }
      }
    }
    return app.inject({ method: 'PUT', url: `${url}/${key}`, headers, payload })
  }

  async function tested(payload: object = { ...aiValue, apiKey: secret }): Promise<string> {
    const response = await app.inject({ method: 'POST', url: `${url}/ai/test`, headers, payload })
    expect(response.statusCode, response.body).toBe(200)
    return response.json().draftToken as string
  }
  async function save(payload: object): Promise<Awaited<ReturnType<typeof app.inject>>> {
    return app.inject({ method: 'PUT', url: `${url}/ai`, headers, payload })
  }

  it('fal test/save/delete stores only tested secrets and immediately updates capabilities', async () => {
    const fetcher = vi.fn().mockImplementation(async (): Promise<Response> => new Response('{}', { status: 404 }))
    vi.stubGlobal('fetch', fetcher)
    const apiKey = 'mock-fal-key-12345678'
    expect((await app.inject({ url: `${url}/fal`, headers })).json()).toEqual({ configured: false, source: 'none' })
    expect((await app.inject({ method: 'PUT', url: `${url}/fal`, headers, payload: { value: {}, secret: apiKey } })).json()).toEqual({ code: 'USE_SETTINGS_ENDPOINT' })
    expect((await app.inject({ method: 'PUT', url: `${url}/fal`, headers, payload: { apiKey } })).json()).toMatchObject({ code: 'TEST_REQUIRED' })
    const tested = await app.inject({ method: 'POST', url: `${url}/fal/test`, headers, payload: { apiKey } })
    expect(tested.statusCode).toBe(200)
    expect(publicServiceInfo('ready').features.avatars).toBe(false)
    const draftToken = tested.json().draftToken as string
    const payload = { apiKey, draftToken }
    const saved = await app.inject({ method: 'PUT', url: `${url}/fal`, headers, payload })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ configured: true, source: 'setting', masked: '••••5678', lastTest: { ok: true } })
    expect(await getSettingSecret('fal')).toBe(apiKey)
    expect(rows.get('fal')!.secretCiphertext!.equals(Buffer.from(apiKey))).toBe(false)
    expect(publicServiceInfo('ready').features.avatars).toBe(true)
    expect((await app.inject({ method: 'PUT', url: `${url}/fal`, headers, payload })).json()).toMatchObject({ code: 'TEST_REQUIRED' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]).toEqual([expect.stringMatching(/^https:\/\/queue.fal.run\/fal-ai\/nano-banana-2\/requests\/[\da-f-]{36}\/status$/),
      expect.objectContaining({ method: 'GET', redirect: 'error', headers: { Authorization: `Key ${apiKey}` } })])
    expect(saved.body + logs).not.toContain(apiKey)
    expect(logs).not.toContain(draftToken)
    expect((await app.inject({ method: 'DELETE', url: `${url}/fal`, headers })).statusCode).toBe(204)
    expect(publicServiceInfo('ready').features.avatars).toBe(false)
  })

  it('fal rejects env overrides and strict/unauthorized drafts; official profile registers no settings routes', async () => {
    vi.stubGlobal('fetch', vi.fn())
    for (const payload of [{ apiKey: 'short' }, { apiKey: 'x'.repeat(513) }, { apiKey: secret, extra: true }]) {
      expect((await app.inject({ method: 'POST', url: `${url}/fal/test`, headers, payload })).statusCode).toBe(400)
    }
    for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
      expect((await app.inject({ method, url: `${url}/fal${method === 'POST' ? '/test' : ''}`, headers: { authorization: 'Bearer member' } })).statusCode).toBe(403)
    }
    config.FAL_KEY = 'env-mock-key-12345678'
    for (const method of ['PUT', 'DELETE'] as const) {
      expect((await app.inject({ method, url: `${url}/fal`, headers, ...(method === 'PUT' ? { payload: { apiKey: secret } } : {}) })).json()).toMatchObject({ code: 'ENV_OVERRIDE' })
    }
    expect((await app.inject({ url: `${url}/fal`, headers })).json()).toEqual({ configured: true, source: 'env', masked: '••••5678' })
    config.SKILLHUB_PROFILE = 'yitan-official'
    const official = Fastify()
    await official.register(instanceSettingsRoutes, { prefix: url })
    try {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
        expect((await official.inject({ method, url: `${url}/fal${method === 'POST' ? '/test' : ''}`, headers })).statusCode).toBe(404)
      }
    } finally { await official.close() }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('requires a tested draft, commits value and encrypted key together, returns only masks and consumes the token once', async () => {
    expect((await save({ ...aiValue, apiKey: secret })).json()).toMatchObject({ code: 'TEST_REQUIRED' })
    const draftToken = await tested()
    const response = await save({ ...aiValue, apiKey: secret, draftToken })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ source: 'setting', keyLast4: '1234', lastTest: { ok: true, latencyMs: expect.any(Number) } })
    expect(response.body).not.toContain(secret)
    expect(mockDb.serverSetting.upsert).toHaveBeenCalledTimes(1)
    expect(await getSettingSecret('ai')).toBe(secret)
    expect((await save({ ...aiValue, apiKey: secret, draftToken })).json()).toMatchObject({ code: 'TEST_REQUIRED' })
    expect(logs).not.toContain(secret)
    expect(logs).not.toContain(draftToken)
  })

  it('rejects expired, changed, policy-changed, different-admin and concurrent duplicate drafts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let draftToken = await tested()
    vi.setSystemTime(Date.now() + 600_001)
    expect((await save({ ...aiValue, apiKey: secret, draftToken })).statusCode).toBe(409)
    draftToken = await tested()
    expect((await save({ ...aiValue, model: 'changed', apiKey: secret, draftToken })).statusCode).toBe(409)
    expect((await save({ ...aiValue, baseUrl: 'https://changed.test', draftToken })).json().code).toBe('TEST_REQUIRED')
    expect((await save({ ...aiValue, apiKey: 'another-key', draftToken })).statusCode).toBe(409)
    await writeServerSetting('ai.policy', { value: { limits: { instanceDaily: 20, perUserDaily: 10 }, allowedPrivateHosts: ['localhost'] } }, 'admin-1')
    expect((await save({ ...aiValue, apiKey: secret, draftToken })).statusCode).toBe(409)
    const { saveAiDraft, resolveAiDraft } = await import('../lib/ai-settings.js')
    draftToken = await tested()
    await expect(saveAiDraft(await resolveAiDraft({ ...aiValue, protocol: 'openai', apiKey: secret }), draftToken, 'admin-2')).rejects.toMatchObject({ code: 'TEST_REQUIRED' })
    const results = await Promise.all([save({ ...aiValue, apiKey: secret, draftToken }), save({ ...aiValue, apiKey: secret, draftToken })])
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409])
  })

  it('keeps old settings on provider/parse/save failure and never returns or logs raw errors', async () => {
    await put('ai', { value: aiValue, secret })
    provider.mockRejectedValueOnce(new Error(`provider leaked ${secret}`))
    const failed = await app.inject({ method: 'POST', url: `${url}/ai/test`, headers, payload: { ...aiValue, apiKey: secret } })
    expect(failed.statusCode).toBe(503)
    expect(failed.body).not.toContain(secret)
    provider.mockResolvedValueOnce({ choices: [{ message: { content: 'not json' } }] })
    expect((await app.inject({ method: 'POST', url: `${url}/ai/test`, headers, payload: { ...aiValue, apiKey: secret } })).json().code).toBe('AI_INVALID_RESPONSE')
    const draftToken = await tested({ ...aiValue, model: 'new', apiKey: 'new-secret' })
    mockDb.serverSetting.upsert.mockRejectedValueOnce(new Error(secret))
    expect((await save({ ...aiValue, model: 'new', apiKey: 'new-secret', draftToken })).statusCode).toBe(503)
    expect(getSettingValue('ai')).toEqual(aiValue)
    expect(await getSettingSecret('ai')).toBe(secret)
    expect(logs).not.toContain(secret)
    expect(logs).not.toContain('new-secret')
  })

  it('reuses a saved key only at the identical normalized base URL, and supports model discovery', async () => {
    await put('ai', { value: aiValue, secret })
    provider.mockResolvedValueOnce({ data: [{ id: 'one' }, { id: 'two' }] })
    const response = await app.inject({ method: 'POST', url: `${url}/ai/models`, headers,
      payload: { protocol: 'openai', baseUrl: aiValue.baseUrl } })
    expect(response.json()).toEqual({ models: ['one', 'two'] })
    expect(provider.mock.calls[0][1]).toEqual({ authorization: `Bearer ${secret}` })
    provider.mockClear()
    for (const endpoint of ['models', 'test']) {
      const response = await app.inject({ method: 'POST', url: `${url}/ai/${endpoint}`, headers,
        payload: { protocol: 'openai', baseUrl: 'https://new.example.test/v1', ...(endpoint === 'test' ? { model: 'one' } : {}) } })
      expect(response.json()).toMatchObject({ code: 'API_KEY_REQUIRED' })
    }
    expect(provider).not.toHaveBeenCalled()
  })

  it.each(['anthropic', 'openai-responses'] as const)('tests real structured output for %s', async protocol => {
    provider.mockResolvedValueOnce(protocol === 'anthropic' ? { content: [{ type: 'text', text: '{"ok":true}' }] }
      : { output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }] })
    await tested({ ...aiValue, protocol, apiKey: secret })
    expect(provider.mock.calls[0][2]).toMatchObject(protocol === 'anthropic' ? { max_tokens: 64 } : { max_output_tokens: 64 })
  })

  it('locks env settings and separates member status from all admin operations', async () => {
    Object.assign(config, { AI_API_BASE_URL: aiValue.baseUrl, AI_API_KEY: secret })
    expect((await save({ ...aiValue, apiKey: 'other' })).json().code).toBe('ENV_OVERRIDE')
    expect((await app.inject({ method: 'DELETE', url: `${url}/ai`, headers })).json().code).toBe('ENV_OVERRIDE')
    const status = await app.inject({ url: '/api/instance/ai/status', headers: { authorization: 'Bearer member' } })
    expect(status.json()).toEqual({ configured: true, source: 'env' })
    expect(status.headers['cache-control']).toBe('no-store')
    for (const [method, path] of [['GET', '/ai'], ['POST', '/ai/test'], ['POST', '/ai/models'], ['PUT', '/ai/policy'],
      ['GET', '/overview'], ['GET', '/members'], ['PUT', '/registration'], ['POST', '/registration/regenerate']] as const) {
      expect((await app.inject({ method, url: `${url}${path}`, headers: { authorization: 'Bearer member' } })).statusCode).toBe(403)
    }
    expect((await app.inject({ url: '/api/instance/ai/status' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'PUT', url: `${url}/%61i`, headers, payload: { value: aiValue, secret } })).statusCode).toBeGreaterThanOrEqual(400)
  })

  it('updates registration, reveals a generated invitation once, and honours env override', async () => {
    config.REGISTRATION_ENV_OVERRIDE = false
    config.REGISTRATION_INVITE_CODE = undefined
    const generated = await app.inject({ method: 'POST', url: `${url}/registration/regenerate`, headers })
    const inviteCode = generated.json().inviteCode as string
    expect(inviteCode.length).toBeGreaterThanOrEqual(16)
    expect(await getSettingSecret('registration')).toBe(inviteCode)
    const response = await app.inject({ url: `${url}/registration`, headers })
    expect(response.json()).toMatchObject({ mode: 'invite', source: 'setting', inviteCodeMask: `••••${inviteCode.slice(-4)}` })
    expect(response.body).not.toContain(inviteCode)
    expect(publicServiceInfo('ready').auth.registration).toBe('invite')
    config.REGISTRATION_ENV_OVERRIDE = true
    expect((await app.inject({ method: 'PUT', url: `${url}/registration`, headers, payload: { mode: 'open' } })).json().code).toBe('ENV_OVERRIDE')
    expect(logs).not.toContain(inviteCode)
  })

  it('returns paginated members and honest overview fields', async () => {
    mockDb.user.count.mockResolvedValue(2)
    mockDb.user.findMany.mockResolvedValue([{ id: 'one', email: 'one@example.test', displayName: 'One', marketplaceRole: 'admin', createdAt: new Date() }])
    const members = await app.inject({ url: `${url}/members?limit=1&offset=0`, headers })
    expect(members.json()).toMatchObject({ total: 2, members: [{ role: 'admin', id: 'one' }] })
    expect((await app.inject({ url: `${url}/members?limit=101`, headers })).statusCode).toBe(400)
    mockDb.aiDailyUsage.findUnique.mockResolvedValue({ count: 17 })
    config.MIN_CLIENT_VERSION = '0.32.0'
    const overview = await app.inject({ url: `${url}/overview`, headers })
    expect(overview.json()).toMatchObject({ memberCount: 2, addresses: { primary: { https: true, certificate: 'reverse_proxy' } },
      storage: { provider: 'builtin', media: { bytes: expect.any(Number), complete: expect.any(Boolean) } }, version: { server: expect.any(String), buildId: expect.any(String) },
      aiUsage: { used: 17, limit: config.AI_GLOBAL_DAILY_LIMIT }, minClientVersion: '0.32.0' })
    config.MIN_CLIENT_VERSION = undefined
    mockDb.aiDailyUsage.findUnique.mockResolvedValue(null)
    expect((await app.inject({ url: `${url}/overview`, headers })).json()).toMatchObject({ aiUsage: { used: 0 }, minClientVersion: null })
  })
  it('requires administrator permission and protects the last administrator before changing marketplaceRole', async () => {
    const id = '00000000-0000-4000-8000-000000000001'
    const endpoint = `${url}/members/${id}/role`
    const send = (role: string, authorization?: string): ReturnType<typeof app.inject> => app.inject({
      method: 'PUT', url: endpoint, headers: authorization ? { authorization } : {}, payload: { role },
    })
    expect((await send('admin')).statusCode).toBe(401)
    expect((await send('admin', 'Bearer member')).statusCode).toBe(403)
    expect((await send('owner', 'Bearer admin')).statusCode).toBe(400)
    mockDb.user.findUnique.mockResolvedValue({ id, marketplaceRole: 'admin' })
    mockDb.user.count.mockResolvedValue(1)
    expect((await send('member', 'Bearer admin')).json()).toMatchObject({ code: 'LAST_ADMIN' })
    expect(mockDb.user.update).not.toHaveBeenCalled()
    expect(mockDb.$executeRaw.mock.calls[0][0].join('')).toContain('LOCK TABLE "users" IN SHARE ROW EXCLUSIVE MODE')
    mockDb.user.count.mockResolvedValue(2)
    mockDb.user.update.mockResolvedValue({ id, displayName: 'Member', email: 'member@example.test', createdAt: new Date() })
    expect((await send('member', 'Bearer admin')).json()).toMatchObject({ id, role: 'member' })
    expect(mockDb.user.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { marketplaceRole: 'user' } }))
    expect((await send('admin', 'Bearer admin')).json()).toMatchObject({ role: 'admin' })
    expect(mockDb.user.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { marketplaceRole: 'admin' } }))
    expect(logs).toContain('instance_member_role_changed')
    expect(logs).not.toContain('member@example.test')
    mockDb.user.findUnique.mockResolvedValueOnce({ marketplaceRole: 'user' })
    expect((await send('admin', 'Bearer admin')).statusCode).toBe(403)
    mockDb.user.findUnique.mockResolvedValueOnce({ marketplaceRole: 'admin' }).mockResolvedValueOnce(null)
    expect((await send('admin', 'Bearer admin')).statusCode).toBe(404)
  })
  it('enforces the persisted invitation at the real registration route, supports rotation, and honours registration disable', async () => {
    config.REGISTRATION_ENV_OVERRIDE = false
    config.REGISTRATION_INVITE_CODE = undefined
    config.LOCAL_REGISTRATION_ENABLED = true
    await app.register(jwt, { secret: config.JWT_SECRET })
    await app.register(authRoutes, { prefix: '/api/auth' })
    mockDb.user.create.mockResolvedValue({ id: 'new-user', email: 'new@example.test', displayName: 'New', tokenVersion: 0 })
    const first = await app.inject({ method: 'POST', url: `${url}/registration/regenerate`, headers })
    const inviteCode = first.json().inviteCode as string
    const registration = { email: 'new@example.test', displayName: 'New', password: 'test-password', inviteCode }
    const register = (body: object): ReturnType<typeof app.inject> => app.inject({ method: 'POST', url: '/api/auth/register', payload: body })
    expect((await register({ ...registration, inviteCode: 'wrong' })).statusCode).toBe(403)
    expect((await register(registration)).statusCode).toBe(201)
    await app.inject({ method: 'POST', url: `${url}/registration/regenerate`, headers })
    expect((await register(registration)).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: `${url}/registration`, headers, payload: { mode: 'open' } })).statusCode).toBe(200)
    expect((await register({ ...registration, inviteCode: undefined })).statusCode).toBe(201)
    expect((await app.inject({ method: 'PUT', url: `${url}/registration`, headers, payload: { mode: 'closed' } })).statusCode).toBe(200)
    expect(publicServiceInfo('ready').auth.registration).toBe('closed')
    expect((await register(registration)).json()).toMatchObject({ code: 'REGISTRATION_CLOSED' })
    config.LOCAL_REGISTRATION_ENABLED = false
    expect((await app.inject({ method: 'POST', url: `${url}/registration/regenerate`, headers })).json()).toMatchObject({ code: 'ENV_OVERRIDE' })
    expect((await register(registration)).statusCode).toBe(410)
  })

  it('lists all keys without envelopes or plaintext, encrypts at rest and decrypts on demand', async (): Promise<void> => {
    const empty = await app.inject({ url, headers })
    expect(empty.headers['cache-control']).toBe('no-store')
    expect(empty.json()).toEqual([
      { key: 'ai', value: null, secret: { set: false, mask: null }, version: 0, updatedAt: null, source: 'none' },
      { key: 'fal', value: null, secret: { set: false, mask: null }, version: 0, updatedAt: null, source: 'none' },
      { key: 'avatar.style', value: null, version: 0, updatedAt: null, source: 'none' },
      { key: 'ai.policy', value: null, version: 0, updatedAt: null, source: 'none' },
      { key: 'registration', value: null, secret: { set: false, mask: null }, version: 0, updatedAt: null, source: 'none' },
    ])
    const response = await put('ai', { value: aiValue, secret })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ key: 'ai', value: aiValue, secret: { set: true, mask: '••••1234' }, version: 1, updatedAt: expect.any(String), source: 'setting' })
    const stored = rows.get('ai')!
    expect(stored.updatedById).toBe('admin-1')
    expect(stored.secretCiphertext).toBeInstanceOf(Buffer)
    expect(stored.secretCiphertext!.equals(Buffer.from(secret))).toBe(false)
    expect(JSON.stringify(mockDb.serverSetting.upsert.mock.calls)).not.toContain(secret)
    expect(await getSettingSecret('ai')).toBe(secret)
    expect(getSettingValue('ai')).toEqual(aiValue)
    expect(publicServiceInfo('ready').features.ai).toBe(true)
    const listed = await app.inject({ url, headers })
    expect(listed.body).not.toContain(secret)
    expect(listed.body).not.toContain('Ciphertext')
    expect(JSON.stringify(publicServiceInfo('ready'))).not.toContain(secret)
  })

  it('keeps omitted fields, atomically increments versions, and clears every secret field on null', async (): Promise<void> => {
    await put('ai', { value: aiValue, secret })
    const ciphertext = rows.get('ai')!.secretCiphertext
    expect((await put('ai', { value: { ...aiValue, model: 'new-model' } })).json().version).toBe(2)
    expect(rows.get('ai')!.secretCiphertext).toBe(ciphertext)
    expect(await getSettingSecret('ai')).toBe(secret)
    expect(mockDb.serverSetting.upsert.mock.lastCall?.[0].update).toEqual({
      value: { ...aiValue, model: 'new-model' }, updatedById: 'admin-1', version: { increment: 1 },
    })
    expect((await put('ai', { secret: 'replacement-5678' })).json().version).toBe(3)
    expect(getSettingValue('ai')).toMatchObject({ model: 'new-model' })
    expect(await getSettingSecret('ai')).toBe('replacement-5678')
    const cleared = await put('ai', { secret: null })
    expect(cleared.json()).toMatchObject({ version: 4, secret: { set: false, mask: null } })
    for (const [field, value] of Object.entries(rows.get('ai')!)) {
      if (field.startsWith('secret')) expect(value, field).toBeNull()
    }
    expect(await getSettingSecret('ai')).toBeNull()
    expect(publicServiceInfo('ready').features.ai).toBe(false)
  })

  it.each(['unknown', 'constructor', '__proto__'])('rejects non-allowlisted key %s', async (key): Promise<void> => {
    expect((await put(key, { value: {} })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `${url}/${key}`, headers })).statusCode).toBe(404)
    expect(mockDb.serverSetting.upsert).not.toHaveBeenCalled()
  })

  it.each([
    ['ai', {}], ['ai', { value: {} }], ['ai', { value: { ...aiValue, protocol: 'invalid' } }],
    ['ai', { value: { ...aiValue, baseUrl: 'invalid' } }], ['ai', { value: { ...aiValue, model: '' } }],
    ['ai', { value: { ...aiValue, model: 'm'.repeat(201) } }], ['ai', { value: null }],
    ['ai', { secret: '' }], ['ai', { secret: 's'.repeat(1025) }], ['ai', { secret: 42 }],
    ['ai', { value: { ...aiValue, apiKey: 'hidden' } }], ['ai', { other: 'hidden' }],
    ['fal', { value: { apiKey: 'hidden' } }], ['avatar.style', { value: { styleId: '' } }],
    ['avatar.style', { value: { styleId: 's'.repeat(101) } }],
    ['avatar.style', { secret: 'forbidden' }], ['avatar.style', { secret: null }],
  ])('rejects invalid input for %s: %j', async (key, payload): Promise<void> => {
    expect((await put(key as string, payload as object)).statusCode).toBe(400)
    expect(mockDb.serverSetting.upsert).not.toHaveBeenCalled()
  })

  it.each(['GET', 'PUT', 'DELETE'] as const)('requires an authenticated administrator for %s', async (method): Promise<void> => {
    const path = method === 'GET' ? url : `${url}/ai`
    for (const [authorization, status] of [[undefined, 401], ['Bearer user', 403]] as const) {
      const response = await app.inject({ method, url: path, headers: authorization ? { authorization } : {},
        ...(method === 'PUT' ? { payload: { value: aiValue, secret } } : {}) })
      expect(response.statusCode).toBe(status)
      expect(response.headers['cache-control']).toBe('no-store')
    }
    expect(mockDb.serverSetting.upsert).not.toHaveBeenCalled()
    expect(mockDb.serverSetting.deleteMany).not.toHaveBeenCalled()
  })

  it('fails secret writes without KEK before writing, while non-secret reads/writes and clearing still work', async (): Promise<void> => {
    await put('ai', { value: aiValue, secret })
    config.CREDENTIAL_KEK_BASE64 = undefined
    mockDb.serverSetting.upsert.mockClear()
    const failed = await put('ai', { value: { ...aiValue, model: 'must-not-save' }, secret: 'new-secret' })
    expect(failed.statusCode).toBe(503)
    expect(failed.body).toContain('CREDENTIAL_KEK_BASE64')
    expect(mockDb.serverSetting.upsert).not.toHaveBeenCalled()
    expect(getSettingValue('ai')).toEqual(aiValue)
    expect((await app.inject({ url, headers })).statusCode).toBe(200)
    expect((await put('avatar.style', { value: { styleId: 'print' } })).statusCode).toBe(200)
    expect((await put('ai', { secret: null })).statusCode).toBe(200)
  })

  it('reports env precedence and returns effective env values only to internal callers', async (): Promise<void> => {
    await put('ai', { value: aiValue, secret })
    await put('fal', { value: {}, secret: 'stored-fal-1234' })
    config.AI_API_BASE_URL = 'https://env.example.test/v1'
    config.AI_API_KEY = 'env-ai-secret'
    config.FAL_KEY = 'env-fal-secret'
    expect(effectiveSource('ai')).toBe('env')
    expect(effectiveSource('fal')).toBe('env')
    expect(getSettingValue('ai')).toMatchObject({ baseUrl: config.AI_API_BASE_URL })
    expect(await getSettingSecret('ai')).toBe(config.AI_API_KEY)
    expect(await getSettingSecret('fal')).toBe(config.FAL_KEY)
    const response = await app.inject({ url, headers })
    expect(response.json().slice(0, 2).map((entry: { source: string }) => entry.source)).toEqual(['env', 'env'])
    expect(response.body).not.toContain('env-ai-secret')
    expect(response.body).not.toContain('env-fal-secret')
    config.AI_API_KEY = undefined
    expect(effectiveSource('ai')).toBe('setting')
    expect(await getSettingSecret('ai')).toBe(secret)
  })

  it('loads persisted settings at startup, binds ciphertext to its key, and supports historical KEKs', async (): Promise<void> => {
    await put('ai', { value: aiValue, secret })
    config.CREDENTIAL_KEK_KEYRING_JSON = { '1': config.CREDENTIAL_KEK_BASE64! }
    config.CREDENTIAL_KEK_VERSION = 2
    config.CREDENTIAL_KEK_BASE64 = randomBytes(32).toString('base64')
    await loadServerSettings()
    expect(await getSettingSecret('ai')).toBe(secret)
    rows.set('fal', { ...rows.get('ai')!, key: 'fal', value: {} })
    await loadServerSettings()
    await expect(getSettingSecret('fal')).rejects.toThrow()
  })

  it('allows fal avatars without AI and idempotently deletes rows and cached capabilities', async (): Promise<void> => {
    expect((await put('ai', { secret })).json().value).toBeNull()
    expect(publicServiceInfo('ready').features.ai).toBe(false)
    expect((await put('fal', { secret: 'fal-secret-1234' })).statusCode).toBe(200)
    expect(publicServiceInfo('ready').features).toEqual({ marketplace: false, catalogInstall: true, ai: false, avatars: true, localAiLeases: true, localAiAvatarDrafts: false })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({ method: 'DELETE', url: `${url}/fal`, headers })
      expect(response.statusCode).toBe(204)
      expect(response.headers['cache-control']).toBe('no-store')
    }
    expect(effectiveSource('fal')).toBe('none')
    expect(await getSettingSecret('fal')).toBeNull()
    expect(publicServiceInfo('ready').features.avatars).toBe(false)
  })

  it('does not change the cache on a failed write or echo database error details', async (): Promise<void> => {
    await put('ai', { value: aiValue, secret })
    mockDb.serverSetting.upsert.mockRejectedValueOnce(new Error(`database error ${secret}`))
    const response = await put('ai', { value: { ...aiValue, model: 'not-saved' } })
    expect(response.statusCode).toBe(503)
    expect(response.body).not.toContain(secret)
    expect(getSettingValue('ai')).toEqual(aiValue)
  })
  it('publishes the committed row without a fallible post-commit read', async () => {
    mockDb.serverSetting.findMany.mockRejectedValueOnce(new Error('read unavailable'))
    expect((await put('ai', { value: aiValue, secret })).statusCode).toBe(200)
    expect(getSettingValue('ai')).toEqual(aiValue)
    expect(await getSettingSecret('ai')).toBe(secret)
  })

  it('serializes refresh snapshots and recovers after a failed refresh', async (): Promise<void> => {
    await put('ai', { value: aiValue })
    const oldRow = rows.get('ai')!
    let resolveSnapshot!: (rows: ServerSetting[]) => void
    mockDb.serverSetting.findMany.mockClear()
    mockDb.serverSetting.findMany.mockImplementationOnce((): Promise<ServerSetting[]> => new Promise((resolve) => { resolveSnapshot = resolve }))
    const first = loadServerSettings()
    await Promise.resolve()
    rows.set('ai', { ...oldRow, value: { ...aiValue, model: 'latest' }, version: 2 })
    const second = loadServerSettings()
    expect(mockDb.serverSetting.findMany).toHaveBeenCalledTimes(1)
    resolveSnapshot([oldRow])
    await Promise.all([first, second])
    expect(getSettingValue('ai')).toMatchObject({ model: 'latest' })
    mockDb.serverSetting.findMany.mockRejectedValueOnce(new Error('read unavailable'))
    await expect(loadServerSettings()).rejects.toThrow('read unavailable')
    await loadServerSettings()
    expect(getSettingValue('ai')).toMatchObject({ model: 'latest' })
  })
})
