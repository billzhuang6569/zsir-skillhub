import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  profile: 'selfhost', configured: false, user: vi.fn(), skills: vi.fn(), skill: vi.fn(), write: vi.fn(),
  lease: vi.fn(), upsert: vi.fn(), update: vi.fn(), remove: vi.fn(), removeMany: vi.fn(), lock: vi.fn(),
  leases: vi.fn(), jobs: vi.fn(), job: vi.fn(), jobWrite: vi.fn(), style: vi.fn(), mirror: vi.fn(),
}))
vi.mock('../config.js', async () => {
  const { configSchema } = await import('../config-schema.js')
  return { config: { ...configSchema.parse(process.env), SKILL_AVATAR_MODEL_READS: 'variants', get SKILLHUB_PROFILE(): string { return mock.profile } } }
})
vi.mock('../db.js', () => {
  const tx = {
    user: { findUnique: mock.user }, skill: { findMany: mock.skills, findUnique: mock.skill, updateMany: mock.write },
    localAiLease: { findMany: mock.leases, findUnique: mock.lease, update: mock.update, delete: mock.remove, deleteMany: mock.removeMany },
    avatarGenerationJob: { findMany: mock.jobs, findUnique: mock.job, updateMany: mock.jobWrite },
    $queryRaw: mock.upsert,
  }
  return { db: { ...tx, $transaction: (fn: (transaction: typeof tx) => Promise<unknown>): Promise<unknown> => fn(tx) } }
})
vi.mock('../lib/ai-settings.js', () => ({ aiStatus: () => ({ configured: mock.configured }) }))
vi.mock('../lib/avatar-generation.js', () => ({ avatarGenerationEnabled: () => true }))
vi.mock('../lib/avatar-styles.js', () => ({ getAvatarStyle: mock.style }))
vi.mock('../lib/avatar-jobs.js', () => ({ mirrorAvatarJob: mock.mirror }))
vi.mock('../lib/instance-identity.js', () => ({ getInstanceIdentity: () => ({ id: 'instance' }) }))
vi.mock('../lib/mutation-lock.js', () => ({ lockUserMutation: mock.lock }))
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.headers.authorization) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    request.user = { id: 'owner', email: '', displayName: '', marketplaceRole: 'user' }
    if (!request.headers['x-no-version']) request.verifiedAuthToken = { sub: 'owner', ver: 1 }
  },
}))
import { localAiRoutes } from './local-ai.js'
import { buildLocalAiInput, localAiInputHash, LOCAL_AI_CONFIG_VERSION, LOCAL_AI_LEASE_TTL_MS } from '../lib/local-ai-tasks.js'
import { avatarDraftInput, avatarDraftInputHash, avatarDraftClientOnline, AVATAR_DRAFT_CONFIG_VERSION } from '../lib/local-ai-tasks.js'
import { classicAvatarStyle } from '../lib/avatar-style-catalog.js'

const now = new Date('2026-10-18T12:00:00Z')
const skill = { id: 'skill', authorId: 'owner', name: 'weekly', description: 'Weekly', sourceContent: '# Weekly',
  analysisStatus: 'unanalysed', deletedAt: null, updatedAt: now, labelsManuallyEdited: true, labels: ['manual'], localAiLeases: [] }
const inputHash = localAiInputHash(skill.id, buildLocalAiInput(skill))
const lease = { id: 'lease', userId: 'owner', skillId: skill.id, type: 'analyzeSkill', inputHash,
  configVersion: LOCAL_AI_CONFIG_VERSION, tokenVersion: 1, state: 'leased', failureCount: 0,
  expiresAt: new Date(now.getTime() + LOCAL_AI_LEASE_TTL_MS) }
const profile = { displayName: '周报', description: '整理文档', category: '协作与办公', labels: ['文档处理', '办公效率'], triggerScenarios: ['周报整理'] }
const body = { inputHash, configVersion: LOCAL_AI_CONFIG_VERSION, profile }
const headers = { authorization: 'Bearer test' }
const avatarJob = { id: 'avatar-job', ownerId: 'owner', logicalSkillId: 'anchor', styleId: 'classic', styleVersion: 1,
  status: 'drafting', prompt: null, submittedAt: null, requestId: null,
  input: { name: 'Research', description: 'Research notes', scenarios: ['Write a summary'] } }
const draftInput = avatarDraftInput(avatarJob.input, classicAvatarStyle)!
const draftHash = avatarDraftInputHash(avatarJob.id, classicAvatarStyle, draftInput)
const drawing = (classicAvatarStyle.legacy.fixedStyle + '\n' + 'A balanced geometric composition. '.repeat(12)).trim()
const draftBody = { inputHash: draftHash, configVersion: AVATAR_DRAFT_CONFIG_VERSION, prompt: drawing }
const draftLease = { ...lease, skillId: null, avatarJobId: avatarJob.id, type: 'draftAvatarPrompt',
  inputHash: draftHash, configVersion: AVATAR_DRAFT_CONFIG_VERSION }
let app: FastifyInstance

beforeEach(async (): Promise<void> => {
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now)
  mock.profile = 'selfhost'; mock.configured = false
  mock.leases.mockResolvedValue([]); mock.jobs.mockResolvedValue([])
  mock.style.mockResolvedValue(classicAvatarStyle); mock.jobWrite.mockResolvedValue({ count: 1 })
  mock.user.mockResolvedValue({ tokenVersion: 1 }); mock.skills.mockResolvedValue([skill]); mock.skill.mockResolvedValue(skill)
  mock.lease.mockResolvedValue(lease); mock.upsert.mockResolvedValue([{ id: 'lease' }]); mock.write.mockResolvedValue({ count: 1 })
  app = Fastify()
  await app.register(localAiRoutes, { prefix: '/api/local-ai' })
})
afterEach(async (): Promise<void> => { await app.close(); vi.useRealTimers() })
const claim = (): Promise<LightMyRequestResponse> => app.inject({ method: 'POST', url: '/api/local-ai/leases', headers, payload: { types: ['analyzeSkill'] } })
const result = (payload: object = body): Promise<LightMyRequestResponse> => app.inject({ method: 'POST', url: '/api/local-ai/leases/lease/result', headers, payload })

describe('local AI leases', () => {
  it('records local draft availability even on 204 and expires it after five minutes', async (): Promise<void> => {
    const response = await app.inject({ method: 'POST', url: '/api/local-ai/leases', headers, payload: { types: ['draftAvatarPrompt'] } })
    expect(response.statusCode).toBe(204); expect(avatarDraftClientOnline('owner')).toBe(true)
    expect(mock.skills).not.toHaveBeenCalled()
    vi.setSystemTime(new Date(now.getTime() + 300_000)); expect(avatarDraftClientOnline('owner')).toBe(false)
  })
  it('claims drafts before analysis with bounded input, fixed brief, hash and TTL', async (): Promise<void> => {
    mock.jobs.mockResolvedValue([avatarJob])
    const response = await app.inject({ method: 'POST', url: '/api/local-ai/leases', headers, payload: { types: ['analyzeSkill', 'draftAvatarPrompt'] } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ leaseId: expect.any(String), type: 'draftAvatarPrompt', expiresAt: lease.expiresAt.toISOString(),
      configVersion: AVATAR_DRAFT_CONFIG_VERSION, inputHash: draftHash, instanceId: 'instance', avatarJobId: avatarJob.id, input: draftInput })
    expect(mock.skills).not.toHaveBeenCalled()
    expect(mock.upsert.mock.calls[0][0].join('')).toContain('ON CONFLICT ("avatarJobId", "type")')
  })
  it('bounds and redacts draft metadata and rejects briefs over 16 KiB', () => {
    const style = { ...classicAvatarStyle, inputTemplate: { name: { maxLength: 12 }, description: { maxLength: 20 }, scenarios: { maxItems: 1, maxLength: 15 } } }
    const input = avatarDraftInput({ name: 'x'.repeat(100), description: 'API_KEY=secret-value-for-fixture', scenarios: ['a'.repeat(50), 'ignored'] }, style)!
    expect(input.name).toHaveLength(12); expect(input.description).not.toContain('secret-value')
    expect(input.scenarios).toEqual(['a'.repeat(15)])
    expect(avatarDraftInput(avatarJob.input, { ...style, metaPrompt: '界'.repeat(6000) })).toBeNull()
  })
  it('wakes direct fallback when a brief is oversized and does not issue a lease', async (): Promise<void> => {
    mock.jobs.mockResolvedValue([avatarJob]); mock.style.mockResolvedValue({ ...classicAvatarStyle, metaPrompt: 'x'.repeat(16385) })
    const response = await app.inject({ method: 'POST', url: '/api/local-ai/leases', headers, payload: { types: ['draftAvatarPrompt'] } })
    expect(response.statusCode).toBe(204); expect(mock.upsert).not.toHaveBeenCalled()
    expect(mock.jobWrite.mock.calls[0][0].data).toEqual({ nextAttemptAt: now })
  })
  it('accepts only the bound draft and atomically requeues with a server canvas', async (): Promise<void> => {
    mock.lease.mockResolvedValue(draftLease); mock.job.mockResolvedValue(avatarJob)
    const response = await result(draftBody)
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ avatarJobId: avatarJob.id, accepted: true })
    expect(mock.jobWrite).toHaveBeenCalledWith({ where: { id: avatarJob.id, ownerId: 'owner', status: 'drafting', prompt: null, submittedAt: null, requestId: null },
      data: expect.objectContaining({ status: 'queued', prompt: drawing + '\n\n' + classicAvatarStyle.legacy.canvas,
        path: 'meta', promptSource: 'local', draftDeadline: null, leaseToken: null, leaseUntil: null, nextAttemptAt: now }) })
    expect(mock.remove).toHaveBeenCalledWith({ where: { id: lease.id } })
  })
  it.each(['short', 'x'.repeat(12001), 'x'.repeat(400), drawing + '中文', drawing + 'かな', drawing + '한글',
    drawing + '\nAPI_KEY=secret-value-for-fixture'])('rejects invalid draft output without consuming the lease', async (prompt): Promise<void> => {
    mock.lease.mockResolvedValue(draftLease); mock.job.mockResolvedValue(avatarJob)
    expect((await result({ ...draftBody, prompt })).statusCode).toBe(400)
    expect(mock.jobWrite).not.toHaveBeenCalled(); expect(mock.remove).not.toHaveBeenCalled()
  })
  it.each([{ extra: true }, { profile }])('strictly rejects extra result fields', async (extra): Promise<void> => {
    expect((await result({ ...draftBody, ...extra })).statusCode).toBe(400)
  })
  it.each([{ userId: 'other', code: 'LEASE_NOT_FOUND', status: 404 },
    { expiresAt: now, code: 'LEASE_EXPIRED', status: 410 }, { tokenVersion: 0, code: 'LEASE_REVOKED', status: 409 },
    { configVersion: 'old', code: 'LEASE_STALE', status: 409 }])('rejects draft lease binding: $code', async ({ code, status, ...change }): Promise<void> => {
    mock.lease.mockResolvedValue({ ...draftLease, ...change }); mock.job.mockResolvedValue(avatarJob)
    const response = await result(draftBody); expect(response.statusCode).toBe(status); expect(response.json().code).toBe(code)
    expect(mock.jobWrite).not.toHaveBeenCalled()
  })
  it.each(['submitting', 'awaiting'])('rejects late results in %s, including expired leases', async (status): Promise<void> => {
    mock.lease.mockResolvedValue({ ...draftLease, expiresAt: now }); mock.job.mockResolvedValue({ ...avatarJob, status })
    const response = await result(draftBody); expect(response.statusCode).toBe(409); expect(response.json().code).toBe('LEASE_STALE')
    expect(mock.jobWrite).not.toHaveBeenCalled()
  })
  it('rejects changed inputs, hashes and losing conditional writes', async (): Promise<void> => {
    mock.lease.mockResolvedValue(draftLease); mock.job.mockResolvedValue({ ...avatarJob, input: { ...avatarJob.input, name: 'Changed' } })
    expect((await result(draftBody)).json().code).toBe('LEASE_STALE'); expect(mock.jobWrite).not.toHaveBeenCalled()
    mock.job.mockResolvedValue(avatarJob)
    expect((await result({ ...draftBody, inputHash: 'a'.repeat(64) })).json().code).toBe('LEASE_STALE')
    mock.jobWrite.mockResolvedValue({ count: 0 }); expect((await result(draftBody)).json().code).toBe('LEASE_STALE')
    expect(mock.remove).not.toHaveBeenCalled()
  })
  it.each(['failure', 'single', 'all'])('releases a draft on %s and wakes the worker without analysis backoff', async (action): Promise<void> => {
    mock.lease.mockResolvedValue(draftLease); mock.leases.mockResolvedValue([draftLease]); mock.job.mockResolvedValue(avatarJob)
    const response = action === 'failure'
      ? await app.inject({ method: 'POST', url: '/api/local-ai/leases/lease/failure', headers, payload: { code: 'TIMEOUT' } })
      : await app.inject({ method: 'DELETE', url: action === 'all' ? '/api/local-ai/leases' : '/api/local-ai/leases/lease', headers })
    expect(response.statusCode).toBe(204); expect(mock.update).not.toHaveBeenCalled()
    expect(mock.jobWrite.mock.calls[0][0]).toMatchObject({ where: { status: 'drafting', prompt: null, submittedAt: null, requestId: null }, data: { nextAttemptAt: now } })
    expect(mock.removeMany).toHaveBeenCalledWith({ where: { id: lease.id, userId: 'owner', state: 'leased' } })
  })
  it('does not register any endpoint for official instances', async (): Promise<void> => {
    await app.close(); mock.profile = 'yitan-official'; app = Fastify()
    await app.register(localAiRoutes, { prefix: '/api/local-ai' })
    expect((await claim()).statusCode).toBe(404)
    expect((await result()).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/local-ai/leases/lease/failure', headers, payload: { code: 'TIMEOUT' } })).statusCode).toBe(404)
    for (const url of ['/api/local-ai/leases', '/api/local-ai/leases/lease']) {
      expect((await app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(404)
    }
  })
  it('requires authentication on every endpoint and a verified token version to claim or submit', async (): Promise<void> => {
    for (const url of ['/api/local-ai/leases', '/api/local-ai/leases/lease/result', '/api/local-ai/leases/lease/failure']) {
      const response = await app.inject({ method: 'POST', url, payload: {} })
      expect(response.statusCode).toBe(401); expect(response.headers['cache-control']).toBe('no-store')
    }
    for (const url of ['/api/local-ai/leases', '/api/local-ai/leases/lease']) {
      expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(401)
    }
    for (const [url, payload] of [['/api/local-ai/leases', { types: ['analyzeSkill'] }], ['/api/local-ai/leases/lease/result', body]] as const) {
      expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-no-version': 'true' }, payload })).statusCode).toBe(401)
    }
  })
  it('prioritizes instance AI, and returns 204 when there is no task', async (): Promise<void> => {
    mock.configured = true
    expect((await claim()).json()).toEqual({ code: 'INSTANCE_AI_CONFIGURED' })
    expect((await claim()).statusCode).toBe(409)
    expect(mock.skills).not.toHaveBeenCalled()
    mock.configured = false; mock.skills.mockResolvedValue([])
    const response = await claim()
    expect(response.statusCode).toBe(204); expect(response.body).toBe('')
    expect(response.headers['cache-control']).toBe('no-store')
  })
  it.each([{ types: [] }, { types: ['unknown'] }, { types: ['analyzeSkill', 'analyzeSkill'] }, { types: ['draftAvatarPrompt', 'draftAvatarPrompt'] }, { types: ['analyzeSkill'], extra: true }])('rejects invalid types or extra fields: %j', async (payload): Promise<void> => {
    expect((await app.inject({ method: 'POST', url: '/api/local-ai/leases', headers, payload })).statusCode).toBe(400)
    expect(mock.upsert).not.toHaveBeenCalled()
  })
  it('returns a versioned, instance-bound, three-minute lease after the user lock', async (): Promise<void> => {
    const response = await claim()
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ leaseId: expect.any(String), type: 'analyzeSkill', expiresAt: lease.expiresAt.toISOString(),
      configVersion: LOCAL_AI_CONFIG_VERSION, inputHash, instanceId: 'instance', skillId: skill.id, input: buildLocalAiInput(skill) })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(mock.lock.mock.invocationCallOrder[0]).toBeLessThan(mock.skills.mock.invocationCallOrder[0])
    expect(mock.skills.mock.calls[0][0]).toMatchObject({ where: { authorId: 'owner', deletedAt: null,
      analysisStatus: 'unanalysed', sourceContent: { not: null }, localAiLeases: { none: { type: 'analyzeSkill', expiresAt: { gt: now } } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  })
  it('does not claim a row lost at the SQL conflict boundary', async (): Promise<void> => {
    mock.upsert.mockResolvedValue([])
    expect((await claim()).statusCode).toBe(204)
  })
  it('skips exhausted same-hash failures but allows changed content and later candidates', async (): Promise<void> => {
    const old = { ...lease, state: 'failed', failureCount: 3 }
    mock.skills.mockResolvedValue([{ ...skill, localAiLeases: [old] }])
    expect((await claim()).statusCode).toBe(204); expect(mock.upsert).not.toHaveBeenCalled()
    mock.skills.mockResolvedValue([{ ...skill, localAiLeases: [old] }, { ...skill, id: 'second', sourceContent: 'changed', localAiLeases: [old] }])
    expect((await claim()).json().skillId).toBe('second')
  })
  it('rechecks the token and AI configuration after waiting for the lock', async (): Promise<void> => {
    mock.user.mockResolvedValue({ tokenVersion: 2 })
    expect((await claim()).statusCode).toBe(401)
    mock.user.mockResolvedValue({ tokenVersion: 1 })
    mock.lock.mockImplementation(async (): Promise<void> => { mock.configured = true })
    expect((await claim()).json().code).toBe('INSTANCE_AI_CONFIGURED')
    expect(mock.upsert).not.toHaveBeenCalled()
  })
  it.each([
    { ...body, profile: { ...profile, displayName: '' } },
    { ...body, profile: { ...profile, extra: true } },
    { ...body, extra: true },
    { ...body, profile: { ...profile, labels: ['文档处理', '文档处理'] } },
    { ...body, profile: { ...profile, category: 'unknown' } },
  ])('strictly rejects invalid result schemas: %j', async (payload): Promise<void> => {
    expect((await result(payload)).statusCode).toBe(400)
    expect((await result(payload)).json()).toEqual({ code: 'INVALID_RESULT' })
    expect(mock.write).not.toHaveBeenCalled()
  })
  it.each(['sk-12345678901234567890', 'password: private-value', 'Authorization: Bearer abcdefghijklmnop1234', 'Bearer abcdefghijklmnop1234',
    'https://user:private-value@example.test', '-----BEGIN PRIVATE KEY-----\nbytes\n-----END PRIVATE KEY-----'])('rejects suspicious result strings: %s', async (secret): Promise<void> => {
    for (const field of ['displayName', 'description', 'triggerScenarios'] as const) {
      const response = await result({ ...body, profile: { ...profile, [field]: field === 'triggerScenarios' ? [secret] : secret } })
      expect(response.statusCode).toBe(400); expect(response.json().code).toBe('INVALID_RESULT')
    }
    expect(mock.write).not.toHaveBeenCalled()
  })
  it.each([null, { ...lease, userId: 'other' }])('hides missing and foreign leases', async (value): Promise<void> => {
    mock.lease.mockResolvedValue(value)
    const response = await result()
    expect(response.statusCode).toBe(404); expect(response.json().code).toBe('LEASE_NOT_FOUND')
  })
  it.each([{ expiresAt: now }, { state: 'failed' }])('rejects expired or failed leases', async (change): Promise<void> => {
    mock.lease.mockResolvedValue({ ...lease, ...change })
    const response = await result()
    expect(response.statusCode).toBe(410); expect(response.json().code).toBe('LEASE_EXPIRED')
  })
  it('rejects both a revoked lease and a token revoked after middleware', async (): Promise<void> => {
    mock.lease.mockResolvedValue({ ...lease, tokenVersion: 0 })
    expect((await result()).json().code).toBe('LEASE_REVOKED')
    mock.lease.mockResolvedValue(lease); mock.user.mockResolvedValue({ tokenVersion: 2 })
    const response = await result()
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe('LEASE_REVOKED')
    expect(mock.write).not.toHaveBeenCalled()
  })
  it.each([{ inputHash: 'a'.repeat(64) }, { configVersion: 'analyzeSkill.v0' }])('rejects mismatched result binding', async (change): Promise<void> => {
    const response = await result({ ...body, ...change })
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe('LEASE_STALE')
  })
  it.each([{ sourceContent: 'edited' }, { description: 'edited' }, { name: 'renamed' }, { deletedAt: now },
    { analysisStatus: 'completed' }, { sourceContent: null }, { authorId: 'other' }])('rejects changed/currently ineligible Skill: %j', async (change): Promise<void> => {
    mock.skill.mockResolvedValue({ ...skill, ...change })
    const response = await result()
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe('LEASE_STALE')
    expect(mock.write).not.toHaveBeenCalled()
  })
  it('does not accept an analysis result for draftAvatarPrompt or previous server versions', async (): Promise<void> => {
    for (const change of [{ type: 'draftAvatarPrompt' }, { configVersion: 'analyzeSkill.v0' }]) {
      mock.lease.mockResolvedValue({ ...lease, ...change })
      expect((await result()).json().code).toBe('LEASE_STALE')
    }
    expect(mock.write).not.toHaveBeenCalled()
  })
  it('writes the Profile, preserves current manual labels, and consumes the lease', async (): Promise<void> => {
    const response = await result()
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ skillId: skill.id, analysisStatus: 'completed' })
    expect(mock.write).toHaveBeenCalledWith({ where: { id: skill.id, authorId: 'owner', deletedAt: null, analysisStatus: 'unanalysed', updatedAt: now },
      data: { ...profile, labels: ['manual'], analysisStatus: 'completed' } })
    expect(mock.remove).toHaveBeenCalledWith({ where: { id: lease.id } })
    mock.skill.mockResolvedValue({ ...skill, labelsManuallyEdited: false })
    await result()
    expect(mock.write.mock.lastCall?.[0].data.labels).toEqual(profile.labels)
  })
  it('accepts ordinary Bearer and Basic documentation', async (): Promise<void> => {
    expect((await result({ ...body, profile: { ...profile, description: '处理 Bearer Token 鉴权；Basic usage' } })).statusCode).toBe(200)
  })
  it('keeps the lease if a concurrent edit wins the conditional Skill write', async (): Promise<void> => {
    mock.write.mockResolvedValue({ count: 0 })
    expect((await result()).json().code).toBe('LEASE_STALE')
    expect(mock.remove).not.toHaveBeenCalled()
  })
  it('validates failure codes and records exponential backoff without result content', async (): Promise<void> => {
    const url = '/api/local-ai/leases/lease/failure'
    for (const payload of [{ code: 'UNKNOWN' }, { code: 'TIMEOUT', message: 'secret' }]) {
      expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400)
    }
    for (const [count, minutes] of [[0, 15], [1, 30], [2, 60], [10, 1440]]) {
      mock.lease.mockResolvedValue({ ...lease, failureCount: count })
      expect((await app.inject({ method: 'POST', url, headers, payload: { code: 'TIMEOUT' } })).statusCode).toBe(204)
      expect(mock.update).toHaveBeenLastCalledWith({ where: { id: lease.id }, data: { state: 'failed', failureCount: count + 1,
        expiresAt: new Date(now.getTime() + minutes * 60_000) } })
    }
    mock.lease.mockResolvedValue({ ...lease, state: 'failed' })
    expect((await app.inject({ method: 'POST', url, headers, payload: { code: 'TIMEOUT' } })).statusCode).toBe(410)
    mock.lease.mockResolvedValue({ ...lease, userId: 'other' })
    expect((await app.inject({ method: 'POST', url, headers, payload: { code: 'TIMEOUT' } })).statusCode).toBe(404)
  })
  it('releases only owned leased rows, individually or all, without counting failure', async (): Promise<void> => {
    for (const url of ['/api/local-ai/leases/lease', '/api/local-ai/leases']) {
      const response = await app.inject({ method: 'DELETE', url, headers })
      expect(response.statusCode).toBe(204); expect(response.headers['cache-control']).toBe('no-store')
    }
    expect(mock.removeMany.mock.calls.map(call => call[0])).toEqual([
      { where: { id: lease.id, userId: 'owner', state: 'leased' } }, { where: { userId: 'owner', state: 'leased' } },
    ])
    expect(mock.update).not.toHaveBeenCalled()
  })
  it('limits each user to 30 claims per minute and returns Retry-After', async (): Promise<void> => {
    mock.skills.mockResolvedValue([])
    for (let count = 0; count < 30; count += 1) expect((await claim()).statusCode).toBe(204)
    const response = await claim()
    expect(response.statusCode).toBe(429); expect(response.headers['retry-after']).toBe('60')
    expect(response.headers['cache-control']).toBe('no-store')
    vi.setSystemTime(new Date(now.getTime() + 60_000))
    expect((await claim()).statusCode).toBe(204)
  })
})
