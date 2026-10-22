vi.mock('../lib/avatar-model.js', async (original) => ({ ...await original<typeof import('../lib/avatar-model.js')>(), mirrorSkillAvatar: vi.fn().mockResolvedValue('mirrored-job') }))
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  skill: { count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  skillAvatar: { count: vi.fn(), groupBy: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(), $queryRaw: vi.fn(), ensure: vi.fn(), worker: vi.fn(), history: vi.fn(),
}))
vi.mock('../db.js', () => ({ db: mock }))
vi.mock('../config.js', () => ({ config: { SKILL_AVATARS_ENABLED: true } }))
vi.mock('../lib/skill-avatars.js', () => ({ ensureSkillAvatar: mock.ensure, runAvatarWorkerOnce: mock.worker,
  avatarStage: (status: string): string => status === 'awaiting' || status === 'transferring' ? status : 'prompting',
  AvatarError: class extends Error { constructor(public readonly statusCode: number, message: string) { super(message) } } }))
vi.mock('../lib/fal.js', () => ({ findSubmittedFalAvatar: mock.history, FalError: class extends Error {} }))
import { checkAvatarBudget, inspectAvatar, parseAvatarOperation, reconcileAvatar, runAvatarOperation } from './skill-avatars.js'

beforeEach(() => {
  vi.clearAllMocks()
  mock.$transaction.mockImplementation(async (fn: (db: typeof mock) => Promise<unknown>): Promise<unknown> => fn(mock))
  mock.skill.count.mockResolvedValue(3)
  mock.skillAvatar.count.mockResolvedValue(0)
  mock.skillAvatar.groupBy.mockResolvedValue([])
  mock.skill.findMany.mockResolvedValue([{ id: 'cloud-1', authorId: 'owner' }])
  mock.skillAvatar.findUnique.mockResolvedValue(null)
  mock.skillAvatar.updateMany.mockResolvedValue({ count: 1 })
})

describe('bounded avatar operations', () => {
  it('defaults to read-only and checks exact integer image budgets before any mutation', async () => {
    expect(parseAvatarOperation([]).mode).toBe('report')
    await runAvatarOperation(parseAvatarOperation(['backfill', '--image-usd', '0.062']))
    expect(mock.ensure).not.toHaveBeenCalled()
    expect(mock.worker).not.toHaveBeenCalled()
    expect(mock.history).not.toHaveBeenCalled()
    expect(() => parseAvatarOperation(['backfill', '--apply'])).toThrow()
    expect(() => parseAvatarOperation(['work', '--limit', '201'])).toThrow()
    const operation = parseAvatarOperation(['backfill', '--apply', '--image-usd', '0.062', '--max-image-usd', '2.542'])
    expect(checkAvatarBudget(41, operation)).toBe(2.542)
    expect(() => checkAvatarBudget(42, operation)).toThrow()
    await expect(runAvatarOperation({ ...operation, budgetMicroUsd: 1 })).rejects.toThrow('budget')
    expect(mock.ensure).not.toHaveBeenCalled()
  })
  it('selects only missing active cloud identities and reuses the shared stable queue', async () => {
    const operation = parseAvatarOperation(['backfill', '--limit', '1', '--apply', '--image-usd', '0.062', '--max-image-usd', '0.062'])
    expect(await runAvatarOperation(operation)).toMatchObject({ selected: 1, queued: 1, dryRun: false })
    expect(mock.skill.findMany.mock.calls[0][0]).toMatchObject({ where: { deletedAt: null, avatar: { is: null } }, take: 1 })
    expect(mock.ensure).toHaveBeenCalledWith({ ownerId: 'owner', skillId: 'cloud-1' })
    mock.skill.findMany.mockResolvedValue([])
    expect(await runAvatarOperation(operation)).toMatchObject({ selected: 0, queued: 0 })
    expect(mock.ensure).toHaveBeenCalledTimes(1)
    expect(mock.worker).not.toHaveBeenCalled()
  })
  it('never re-submits uncertain tasks and binds one unclaimed provider request with a state guard', async () => {
    const task = { id: 'task', status: 'needs_review', requestId: null, prompt: 'saved', submittedAt: new Date(), skillId: 'cloud' }
    mock.skillAvatar.findUnique.mockImplementation(async (args: { where: { id?: string } }): Promise<unknown> => args.where.id ? task : null)
    mock.history.mockResolvedValue(null)
    expect(await reconcileAvatar('task', true)).toBe('unresolved')
    expect(mock.skillAvatar.updateMany).not.toHaveBeenCalled()
    mock.history.mockResolvedValue('provider-request')
    expect(await reconcileAvatar('task', false)).toBe('unique_provider_request')
    expect(mock.$queryRaw).not.toHaveBeenCalled()
    expect(mock.skillAvatar.updateMany).not.toHaveBeenCalled()
    mock.skillAvatar.count.mockResolvedValueOnce(1)
    expect(await reconcileAvatar('task', true)).toBe('ambiguous_or_claimed')
    expect(mock.skillAvatar.updateMany).not.toHaveBeenCalled()
    mock.skillAvatar.findUnique.mockResolvedValueOnce(task).mockResolvedValueOnce({ id: 'already-claimed' })
    expect(await reconcileAvatar('task', true)).toBe('ambiguous_or_claimed')
    expect(mock.skillAvatar.updateMany).not.toHaveBeenCalled()
    expect(await reconcileAvatar('task', true)).toBe('reconciled')
    expect(mock.skillAvatar.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'task', status: 'needs_review', requestId: null, leaseToken: null },
      data: { requestId: 'provider-request', status: 'awaiting' },
    })
    expect(mock.ensure).not.toHaveBeenCalled()
    expect(mock.worker).not.toHaveBeenCalled()
  })

  it('reports error classes and inspects one task without prompts, URLs or identities', async () => {
    mock.skillAvatar.groupBy.mockImplementation(async (args: { by: string[] }): Promise<unknown> => args.by[0] === 'errorCode'
      ? [{ errorCode: 'ai_guard_daily', _count: { _all: 2 } }, { errorCode: 'prompt_timeout', _count: { _all: 1 } }]
      : [{ status: 'failed', _count: { _all: 3 } }])
    const report = await runAvatarOperation(parseAvatarOperation(['report']))
    expect(report).toMatchObject({ failed: 3, errorCodes: { ai_guard_daily: 2, prompt_timeout: 1 }, dryRun: true })

    expect(() => parseAvatarOperation(['inspect'])).toThrow()
    expect(() => parseAvatarOperation(['inspect', '--apply', '--task', '11111111-1111-4111-8111-111111111111'])).toThrow()
    const operation = parseAvatarOperation(['inspect', '--task', '11111111-1111-4111-8111-111111111111'])
    mock.skillAvatar.findUnique.mockResolvedValue({
      status: 'queued', errorCode: 'ai_guard_daily', attempts: 2, nextAttemptAt: new Date('2026-10-10T20:00:00.000Z'),
      submittedAt: null, createdAt: new Date('2026-10-10T03:37:00.000Z'), updatedAt: new Date('2026-10-10T03:39:00.000Z'),
      promptVersion: 'v1', leaseUntil: null, requestId: null, imageUrl: null, imageData: null, assetId: null, url: null,
      skillId: 'cloud', localSkillId: 'device-local', prompt: 'SECRET PROMPT',
    })
    const result = await runAvatarOperation(operation)
    expect(result).toMatchObject({ dryRun: true, task: {
      found: true, status: 'queued', stage: 'prompting', errorCode: 'ai_guard_daily', attempts: 2,
      nextAttemptAt: '2026-10-10T20:00:00.000Z', hasPrompt: true, hasRequestId: false, hasImage: false, hasAsset: false,
      boundToCloudSkill: true, registeredLocally: true,
    } })
    const serialized = JSON.stringify(result)
    for (const forbidden of ['SECRET PROMPT', 'cloud', 'device-local', 'owner']) expect(serialized).not.toContain(forbidden)
    expect(mock.ensure).not.toHaveBeenCalled()
    expect(mock.worker).not.toHaveBeenCalled()
    mock.skillAvatar.findUnique.mockResolvedValue({ ...(await mock.skillAvatar.findUnique()), status: 'failed', errorCode: null })
    expect(await inspectAvatar('11111111-1111-4111-8111-111111111111')).toMatchObject({ status: 'failed', stage: null, errorCode: 'unknown', nextAttemptAt: null })
    mock.skillAvatar.findUnique.mockResolvedValue(null)
    expect(await inspectAvatar('11111111-1111-4111-8111-111111111111')).toEqual({ found: false })
  })
})
