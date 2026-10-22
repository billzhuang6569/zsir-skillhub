import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ skills: vi.fn(), user: vi.fn(), update: vi.fn(), analyze: vi.fn(), reserve: vi.fn(), release: vi.fn(), configured: true }))
vi.mock('../db.js', () => {
  const transaction = { user: { findUnique: mock.user }, skill: { updateMany: mock.update } }
  return { db: { ...transaction, skill: { ...transaction.skill, findMany: mock.skills }, $transaction: (task: (tx: object) => Promise<unknown>) => task(transaction) } }
})
vi.mock('../lib/ai-settings.js', () => ({ aiStatus: () => ({ configured: mock.configured, source: 'setting' }) }))
vi.mock('../lib/ai-budget.js', () => ({ utcDay: () => '2026-10-18', aiBudget: { reserve: mock.reserve, release: mock.release, available: async () => ({ instance: 2, user: 1 }) } }))
vi.mock('../lib/mutation-lock.js', () => ({ lockUserMutation: vi.fn() }))
vi.mock('./skills.js', () => ({ analyzeSkillWithAI: mock.analyze }))
import { aiBatchRoutes } from './ai-batches.js'
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
const profile = { displayName: 'AI', description: 'AI', category: '其他', labels: ['AI label'], triggerScenarios: [] }
let app: FastifyInstance
beforeEach(async () => {
  vi.resetAllMocks(); mock.configured = true
  mock.skills.mockResolvedValue(ids.map(id => ({ id, authorId: 'owner', name: 'skill', sourceContent: 'source', updatedAt: new Date(), labelsManuallyEdited: true, labels: ['manual'] })))
  mock.user.mockResolvedValue({ tokenVersion: 1 }); mock.update.mockResolvedValue({ count: 1 })
  mock.reserve.mockImplementation(async (userId: string) => ({ day: '2026-10-18', userId, remaining: 1 }))
  mock.analyze.mockImplementation(async (_name, _content, _user, reservation) => { reservation.remaining -= 1; return { source: 'ai', profile } })
  mock.release.mockResolvedValue(undefined)
  app = Fastify(); await app.register(sensible)
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const id = String(request.headers['x-user'] ?? 'owner')
    request.user = { id, email: 'owner@example.test', displayName: 'Owner' }
    request.verifiedAuthToken = { sub: id, ver: 1 }
  })
  await app.register(aiBatchRoutes, { prefix: '/batches' })
})
afterEach(async () => { await app.close() })
const payload = { skillIds: ids, confirm: true, aiAnalysisConsent: true }
describe('batch analysis', () => {
  it('previews coverage, requires confirmation, queues only reserved work and preserves manual tags', async () => {
    expect((await app.inject({ method: 'POST', url: '/batches/preview', payload: { skillIds: ids } })).json()).toMatchObject({ total: 2, coverable: 1, mayIncurCost: true })
    expect((await app.inject({ method: 'POST', url: '/batches', payload: { skillIds: ids } })).statusCode).toBe(400)
    const response = await app.inject({ method: 'POST', url: '/batches', payload })
    expect(response.json()).toMatchObject({ queued: 1, skipped: 1 })
    await vi.waitFor(() => expect(mock.release).toHaveBeenCalled())
    expect(mock.analyze).toHaveBeenCalledTimes(1)
    expect(mock.update.mock.calls[0][0]).toMatchObject({ where: { updatedAt: expect.any(Date), authorId: 'owner' }, data: { labels: ['manual'], analysisStatus: 'completed' } })
    expect((await app.inject({ url: `/batches/${response.json().batchId}`, headers: { 'x-user': 'other' } })).statusCode).toBe(404)
  })
  it('cancels queued work, refunds unused reservation, and forbids duplicate batches', async () => {
    mock.reserve.mockImplementation(async (userId: string) => ({ day: '2026-10-18', userId, remaining: 2 }))
    let finish!: () => void
    mock.analyze.mockImplementationOnce(async (_name, _content, _user, reservation) => {
      reservation.remaining -= 1
      await new Promise<void>(resolve => { finish = resolve })
      return { source: 'ai', profile }
    })
    const response = await app.inject({ method: 'POST', url: '/batches', payload })
    await vi.waitFor(() => expect(mock.analyze).toHaveBeenCalled())
    expect((await app.inject({ method: 'POST', url: '/batches', payload })).statusCode).toBe(409)
    expect((await app.inject({ method: 'DELETE', url: `/batches/${response.json().batchId}` })).statusCode).toBe(202)
    finish()
    await vi.waitFor(() => expect(mock.release).toHaveBeenCalledWith(expect.objectContaining({ remaining: 1 })))
    expect(mock.update).not.toHaveBeenCalled()
  })
  it('does not overwrite a concurrent edit and rejects foreign or unconfigured selections', async () => {
    mock.update.mockResolvedValue({ count: 0 })
    const response = await app.inject({ method: 'POST', url: '/batches', payload })
    await vi.waitFor(() => expect(mock.release).toHaveBeenCalled())
    expect((await app.inject({ url: `/batches/${response.json().batchId}` })).json()).toMatchObject({ completed: 0, failed: 1 })
    mock.skills.mockResolvedValue([])
    expect((await app.inject({ method: 'POST', url: '/batches', payload })).statusCode).toBe(404)
    mock.configured = false
    expect((await app.inject({ method: 'POST', url: '/batches', payload })).json().code).toBe('AI_NOT_CONFIGURED')
  })
  it('evicts completed history when capacity is reached', async () => {
    mock.reserve.mockImplementation(async (userId: string) => ({ day: '2026-10-18', userId, remaining: 0 }))
    for (let index = 0; index < 1001; index += 1) {
      const response = await app.inject({ method: 'POST', url: '/batches', headers: { 'x-user': `user-${index}` }, payload })
      expect(response.statusCode).toBe(202)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  })
})
