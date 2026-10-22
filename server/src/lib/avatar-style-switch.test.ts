import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ anchors: vi.fn(), userUpdate: vi.fn(), transaction: vi.fn(), lock: vi.fn(),
  latest: vi.fn(), current: vi.fn(), quota: vi.fn(), write: vi.fn(), create: vi.fn(),
  config: { SKILLHUB_PROFILE: 'yitan-official', SKILL_AVATAR_MODEL_READS: 'variants' } }))
vi.mock('../config.js', () => ({ config: mock.config }))
vi.mock('../db.js', () => ({ db: { skillAvatar: { findMany: mock.anchors }, user: { update: mock.userUpdate }, $transaction: mock.transaction } }))
vi.mock('./avatar-jobs.js', () => ({ resolveAccountAvatarStyle: mock.current, createAvatarJob: mock.create,
  ACTIVE_AVATAR_JOBS: ['queued', 'drafting', 'needs_review'], cancelUnsubmittedAvatarJobs: vi.fn(), mirrorAvatarJob: vi.fn() }))
vi.mock('./avatar-styles.js', () => ({ latestAvatarStyle: mock.latest }))
vi.mock('./mutation-lock.js', () => ({ lockUserMutation: mock.lock }))
vi.mock('./server-settings.js', () => ({ writeServerSetting: mock.write }))
vi.mock('./skill-avatars.js', async original => ({ ...await original<typeof import('./skill-avatars.js')>(), avatarQuotaToday: mock.quota }))
vi.mock('../middleware/auth.js', () => ({ authMiddleware: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  if (!request.headers.authorization) return reply.code(401).send({ error: 'Unauthorized' })
  request.user = { id: 'owner', email: 'test@example.invalid', displayName: 'Test', marketplaceRole: request.headers.authorization === 'admin' ? 'admin' : 'user' }
} }))
import { classicAvatarStyle } from './avatar-style-catalog.js'
import { applyAvatarStyle, previewAvatarStyle } from './avatar-style-switch.js'
import { selectionAvatar } from './avatar-selection.js'
import { skillAvatarRoutes } from '../routes/skill-avatars.js'
import { db } from '../db.js'

const target = { ...classicAvatarStyle, styleId: 'target', fal: { ...classicAvatarStyle.fal, meta: { model: 'fal-ai/nano-banana-2', parameters: {} } } }
beforeEach(() => {
  vi.clearAllMocks()
  mock.config.SKILLHUB_PROFILE = 'yitan-official'; mock.config.SKILL_AVATAR_MODEL_READS = 'variants'
  mock.current.mockResolvedValue({ accountStyleId: null, instanceStyleId: 'classic', style: classicAvatarStyle })
  mock.latest.mockResolvedValue(target)
  mock.quota.mockResolvedValue({ limit: 5, used: 4, remaining: 1 })
  mock.transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>): Promise<unknown> => fn(db))
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
})
afterEach(() => vi.unstubAllGlobals())

it('previews disjoint counts, global quota and conservative costs without writes', async () => {
  mock.anchors.mockResolvedValue([
    { selection: { source: 'custom' }, variants: [{ id: 'old' }], jobs: [] },
    { selection: { source: 'generated' }, variants: [{ id: 'v' }], jobs: [{ id: 'j' }] },
    { selection: { source: 'generated' }, variants: [], jobs: [{ id: 'j' }] },
    ...Array.from({ length: 2 }, () => ({ selection: { source: 'generated' }, variants: [], jobs: [] })),
  ])
  expect(await previewAvatarStyle('owner', 'target')).toEqual({ scope: 'account', currentStyleId: 'classic', targetStyleId: 'target',
    targetStyleVersion: 1, total: 5, customSkipped: 1, reusable: 1, inFlight: 1, needsGeneration: 2,
    perImageUsd: 0.08, estimatedCostUsd: 0.16, quota: { limit: 5, used: 4, remaining: 1 }, coverable: 1 })
  expect(mock.anchors.mock.calls[0][0].where).toMatchObject({ ownerId: 'owner', status: { not: 'superseded' }, selection: { isNot: null },
    OR: [{ skillId: null }, { skill: { is: { authorId: 'owner', deletedAt: null } } }] })
  mock.latest.mockResolvedValue({ ...target, fal: { ...target.fal, meta: { model: 'unknown/model', parameters: {} } } })
  expect(await previewAvatarStyle('owner', 'target')).toMatchObject({ perImageUsd: null, estimatedCostUsd: null })
  expect(mock.transaction).not.toHaveBeenCalled(); expect(mock.write).not.toHaveBeenCalled(); expect(mock.create).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('instance preview aggregates all owners and newOnly changes only the appropriate preference', async () => {
  mock.config.SKILLHUB_PROFILE = 'selfhost'
  mock.anchors.mockResolvedValueOnce([{ ownerId: 'owner' }, { ownerId: 'other' }])
    .mockResolvedValue([{ selection: { source: 'generated' }, variants: [], jobs: [] }])
  expect(await previewAvatarStyle('owner', 'target')).toMatchObject({ scope: 'instance', total: 2, needsGeneration: 2 })
  expect(mock.anchors.mock.calls.slice(1).map(call => call[0].where.ownerId)).toEqual(['owner', 'other'])
  mock.anchors.mockClear()
  const zeros = { styleId: 'target', styleVersion: 1, reused: 0, queued: 0, skippedCustom: 0, deferredByQuota: 0, cancelledUnsubmitted: 0 }
  expect(await applyAvatarStyle('owner', { styleId: 'target', mode: 'newOnly' })).toEqual(zeros)
  expect(mock.write).toHaveBeenCalledWith('avatar.style', { value: { styleId: 'target' } }, 'owner')
  expect(mock.userUpdate).not.toHaveBeenCalled(); expect(mock.anchors).not.toHaveBeenCalled()
  mock.config.SKILLHUB_PROFILE = 'yitan-official'
  expect(await applyAvatarStyle('owner', { styleId: null, mode: 'newOnly' })).toEqual(zeros)
  expect(mock.userUpdate).toHaveBeenCalledWith({ where: { id: 'owner' }, data: { avatarStyleId: null } })
  expect(mock.lock).toHaveBeenCalledWith(db, 'owner'); expect(mock.create).not.toHaveBeenCalled()
})

it('guards style routes by read mode, role and strict bodies; exposes scope/canManage', async () => {
  const app = Fastify()
  await app.register(sensible); await app.register(skillAvatarRoutes)
  mock.anchors.mockResolvedValue([])
  try {
    for (const path of ['/style/preview', '/style/apply']) {
      const payload = { styleId: 'target', ...(path.endsWith('apply') ? { mode: 'newOnly' } : {}) }
      expect((await app.inject({ method: 'POST', url: path, payload })).statusCode).toBe(401)
      mock.config.SKILLHUB_PROFILE = 'selfhost'
      expect((await app.inject({ method: 'POST', url: path, headers: { authorization: 'member' }, payload })).statusCode).toBe(403)
      expect((await app.inject({ method: 'POST', url: path, headers: { authorization: 'admin' }, payload: { ...payload, extra: true } })).statusCode).toBe(400)
      expect((await app.inject({ method: 'POST', url: path, headers: { authorization: 'admin' }, payload })).statusCode).toBe(200)
      mock.config.SKILL_AVATAR_MODEL_READS = 'legacy'
      expect((await app.inject({ method: 'POST', url: path, headers: { authorization: 'admin' }, payload })).statusCode).toBe(404)
      mock.config.SKILL_AVATAR_MODEL_READS = 'variants'
      mock.config.SKILLHUB_PROFILE = 'yitan-official'
      expect((await app.inject({ method: 'POST', url: path, headers: { authorization: 'member' }, payload })).statusCode).toBe(200)
    }
    for (const profile of ['selfhost', 'yitan-official']) {
      mock.config.SKILLHUB_PROFILE = profile
      for (const role of ['admin', 'member']) {
        expect((await app.inject({ url: '/style', headers: { authorization: role } })).json()).toMatchObject({
          scope: profile === 'selfhost' ? 'instance' : 'account', canManage: profile !== 'selfhost' || role === 'admin',
        })
      }
    }
  } finally { await app.close() }
})

it('orders competing instance switches across owner batches, including newOnly', async () => {
  mock.config.SKILLHUB_PROFILE = 'selfhost'
  mock.latest.mockImplementation(async (styleId: string): Promise<typeof target> => ({ ...target, styleId }))
  mock.anchors.mockResolvedValue([])
  let release!: () => void, began!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  mock.write.mockImplementationOnce(async (): Promise<void> => {
    began()
    await new Promise<void>(resolve => { release = resolve })
  })
  const first = applyAvatarStyle('owner', { styleId: 'first', mode: 'applyExisting' })
  await started
  const second = applyAvatarStyle('owner', { styleId: 'second', mode: 'newOnly' })
  expect(mock.write).toHaveBeenCalledTimes(1)
  release()
  expect((await Promise.all([first, second])).map(result => result.styleId)).toEqual(['first', 'second'])
  expect(mock.write.mock.calls.map(call => call[1])).toEqual([{ value: { styleId: 'first' } }, { value: { styleId: 'second' } }])
  expect(mock.anchors).toHaveBeenCalledOnce()
})

it('projects the latest historical image only when no selection image exists; custom and selected A stay authoritative', () => {
  const selection = { source: 'generated', customUrl: 'custom', revision: 2, variant: null, currentJob: { status: 'queued' },
    anchor: { variants: [{ url: 'latest-history' }] } }
  expect(selectionAvatar(selection)).toMatchObject({ avatarUrl: 'latest-history', avatarStatus: 'ready' })
  expect(selectionAvatar({ ...selection, variant: { url: 'selected-A' } })).toMatchObject({ avatarUrl: 'selected-A' })
  expect(selectionAvatar({ ...selection, source: 'custom' })).toMatchObject({ avatarUrl: 'custom', avatarSource: 'custom' })
})
