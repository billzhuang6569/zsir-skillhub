import { beforeEach, expect, it, vi } from 'vitest'
import type { AvatarTask } from './avatar-jobs.js'
const mock = vi.hoisted(() => ({ update: vi.fn(), lease: vi.fn(), job: vi.fn(), anchor: vi.fn(), mirror: vi.fn(), lock: vi.fn() }))
vi.mock('../db.js', () => {
  const tx = { avatarGenerationJob: { updateMany: mock.update, findUniqueOrThrow: mock.job },
    localAiLease: { findFirst: mock.lease }, skillAvatar: { findUniqueOrThrow: mock.anchor, update: mock.mirror } }
  return { db: { $transaction: async (fn: (tx: object) => Promise<unknown>): Promise<unknown> => fn(tx) } }
})
vi.mock('./mutation-lock.js', () => ({ lockUserMutation: mock.lock }))
vi.mock('./skill-avatars.js', () => ({}))
vi.mock('./avatar-model.js', () => ({ avatarPromptHash: () => 'hash' }))
import { persistAvatarJob } from './avatar-jobs.js'
const task = { id: 'job', ownerId: 'owner', status: 'drafting', leaseToken: 'worker', job: { id: 'job', logicalSkillId: 'anchor' } } as AvatarTask
const data = { status: 'submitting', prompt: 'direct prompt', path: 'direct', submittedAt: new Date() }
beforeEach(() => {
  vi.resetAllMocks(); mock.update.mockResolvedValue({ count: 1 }); mock.lease.mockResolvedValue(null)
  const job = { id: 'job', logicalSkillId: 'anchor', status: 'submitting' }
  mock.job.mockResolvedValue(job); mock.anchor.mockResolvedValue({ id: 'anchor', currentJob: job, selection: {} })
})
it('atomically defers to an active local lease and releases the worker token', async (): Promise<void> => {
  const expiresAt = new Date(Date.now() + 180_000); mock.lease.mockResolvedValue({ expiresAt })
  expect(await persistAvatarJob(task, data)).toBe(false)
  expect(mock.update).toHaveBeenCalledExactlyOnceWith({ where: { id: 'job', leaseToken: 'worker', status: 'drafting', prompt: null, submittedAt: null, requestId: null },
    data: { nextAttemptAt: expiresAt, leaseToken: null, leaseUntil: null } })
  expect(mock.lock.mock.invocationCallOrder[0]).toBeLessThan(mock.lease.mock.invocationCallOrder[0])
})
it('downgrades only the drafting row with the worker token and no prior prompt/submission', async (): Promise<void> => {
  expect(await persistAvatarJob(task, data)).toBe(true)
  expect(mock.update.mock.calls[0][0].where).toEqual({ id: 'job', leaseToken: 'worker', status: 'drafting', prompt: null, submittedAt: null, requestId: null })
})
it('does not loosen the queued/prompting submission condition', async (): Promise<void> => {
  expect(await persistAvatarJob({ ...task, status: 'queued' }, data)).toBe(true)
  expect(mock.update.mock.calls[0][0].where).toEqual({ id: 'job', leaseToken: 'worker', status: { in: ['queued', 'prompting'] }, submittedAt: null, requestId: null })
  expect(mock.lease).not.toHaveBeenCalled()
})
it('discards a lost CAS without mirroring or replacing a local result', async (): Promise<void> => {
  mock.update.mockResolvedValue({ count: 0 }); expect(await persistAvatarJob(task, data)).toBe(false)
  expect(mock.job).not.toHaveBeenCalled(); expect(mock.mirror).not.toHaveBeenCalled()
})
