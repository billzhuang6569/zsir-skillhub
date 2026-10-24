import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  task: { findUnique: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
  entry: { findFirst: vi.fn(), findUnique: vi.fn() },
  alias: { findMany: vi.fn(), create: vi.fn() },
  skill: { findFirst: vi.fn(), update: vi.fn() },
  mirror: vi.fn(), variants: vi.fn(), mirrorJob: vi.fn(),
}))
vi.mock('../db.js', () => {
  const tx = { skillAvatar: mocks.task, libraryEntry: mocks.entry, skillAvatarAlias: mocks.alias, skill: mocks.skill }
  return { db: { ...tx, $transaction: async (run: (value: typeof tx) => Promise<unknown>): Promise<unknown> => run(tx) } }
})
vi.mock('../lib/mutation-lock.js', () => ({ lockUserMutation: vi.fn() }))
vi.mock('../lib/avatar-model.js', () => ({ mirrorSkillAvatar: mocks.mirror }))
vi.mock('../lib/avatar-jobs.js', () => ({ mirrorAvatarJob: mocks.mirrorJob }))
vi.mock('../lib/avatar-selection.js', async original => ({ ...await original<typeof import('../lib/avatar-selection.js')>(), variantsMode: mocks.variants }))
import { continueLegacyAvatar, continuationFailure } from './avatar-continuation.js'

const plan = {
  approval: 'private-reviewed-case-526', ownerId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222', oldLocalId: '33333333-3333-4333-8333-333333333333',
  entryId: '44444444-4444-4444-8444-444444444444', entryRevision: 2,
  authorSkillId: '55555555-5555-4555-8555-555555555555', taskUpdatedAt: '2026-10-21T14:36:00.000Z',
}
const original = { id: plan.taskId, ownerId: plan.ownerId, localSkillId: plan.oldLocalId, skillId: null,
  updatedAt: new Date(plan.taskUpdatedAt), status: 'ready', url: 'https://example.invalid/original.webp', assetId: 'fixture-asset',
  requestId: 'fixture-request', leaseToken: null }
const model = { currentJobId: 'fixture-job', currentJob: { ...original, id: 'fixture-job', logicalSkillId: plan.taskId },
  selection: { ownerId: plan.ownerId, logicalSkillId: plan.taskId, currentJobId: 'fixture-job', source: 'generated',
    variant: { url: original.url }, currentJob: { status: 'ready' } } }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.task.findUnique.mockResolvedValue(original)
  mocks.task.count.mockResolvedValue(0)
  mocks.task.updateMany.mockResolvedValue({ count: 1 })
  mocks.entry.findFirst.mockResolvedValue({ revision: 2, authorSkillId: plan.authorSkillId })
  mocks.entry.findUnique.mockResolvedValue(null)
  mocks.alias.findMany.mockResolvedValue([])
  mocks.skill.findFirst.mockResolvedValue({ id: plan.authorSkillId })
})
describe('operator-authorized local avatar continuation', () => {
  it('previews without writes and applies only identity columns, keeping the paid request and image', async () => {
    const preview = await continueLegacyAvatar(plan)
    expect(preview).toMatchObject({ dryRun: true, outcome: 'eligible', approval: plan.approval, taskId: plan.taskId,
      entryId: plan.entryId, skillId: plan.authorSkillId, checks: 'passed', before: { localSkillId: plan.oldLocalId, skillId: null } })
    expect(preview.after).toEqual(preview.before)
    expect(mocks.task.updateMany).not.toHaveBeenCalled()
    expect(mocks.alias.create).not.toHaveBeenCalled()
    const applied = await continueLegacyAvatar(plan, true)
    expect(applied).toMatchObject({ dryRun: false, outcome: 'continued', after: { localSkillId: plan.entryId, skillId: plan.authorSkillId } })
    expect(JSON.stringify(applied)).not.toContain(original.url)
    expect(JSON.stringify(applied)).not.toContain(original.requestId)
    expect(mocks.task.updateMany.mock.calls[0][0].data).toEqual({ localSkillId: plan.entryId, skillId: plan.authorSkillId })
    expect(mocks.alias.create).toHaveBeenCalledWith({ data: { ownerId: plan.ownerId, aliasLocalId: plan.oldLocalId, avatarId: plan.taskId } })
    expect(mocks.skill.update).toHaveBeenCalledWith({ where: { id: plan.authorSkillId }, data: { avatarStatus: 'ready', avatarUrl: original.url } })
    expect(original.requestId).toBe('fixture-request')
  })
  it('supports recovery before author asset creation and variants mirroring', async () => {
    mocks.entry.findFirst.mockResolvedValue({ revision: 2, authorSkillId: null })
    mocks.variants.mockReturnValue(true)
    mocks.task.findUnique.mockResolvedValue({ ...original, ...model })
    await continueLegacyAvatar({ ...plan, authorSkillId: null }, true)
    expect(mocks.mirrorJob).toHaveBeenCalledWith(expect.anything(), plan.taskId)
    expect(mocks.skill.update).not.toHaveBeenCalled()
  })
  it.each([
    { ownerId: 'other' }, { skillId: plan.authorSkillId }, { localSkillId: plan.entryId },
    { status: 'needs_review' }, { leaseToken: 'worker' }, { url: null }, { assetId: null },
    { updatedAt: new Date('2026-10-22T00:00:00Z') },
  ])('refuses changed or unsafe task %j before writing', async patch => {
    mocks.task.findUnique.mockResolvedValue({ ...original, ...patch })
    await expect(continueLegacyAvatar(plan, true)).rejects.toThrow()
    expect(mocks.task.updateMany).not.toHaveBeenCalled()
  })
  it.each([null, { revision: 3, authorSkillId: plan.authorSkillId }, { revision: 2, authorSkillId: 'different' }])('refuses missing, foreign, deleted or changed entry %j', async entry => {
    mocks.entry.findFirst.mockResolvedValue(entry)
    await expect(continueLegacyAvatar(plan, true)).rejects.toThrow()
    expect(mocks.task.updateMany).not.toHaveBeenCalled()
  })
  it('rejects an existing account identity, conflicting tasks, forged aliases and foreign author assets', async () => {
    mocks.entry.findUnique.mockResolvedValue({ id: plan.oldLocalId })
    await expect(continueLegacyAvatar(plan, true)).rejects.toThrow()
    mocks.entry.findUnique.mockResolvedValue(null)
    mocks.task.count.mockResolvedValue(1)
    await expect(continueLegacyAvatar(plan, true)).rejects.toThrow()
    mocks.task.count.mockResolvedValue(0)
    mocks.alias.findMany.mockResolvedValue([{ avatarId: 'other', aliasLocalId: plan.entryId }])
    await expect(continueLegacyAvatar(plan, true)).rejects.toThrow()
    mocks.alias.findMany.mockResolvedValue([{ avatarId: plan.taskId, aliasLocalId: 'another-entry' }])
    await expect(continueLegacyAvatar(plan, true)).rejects.toThrow()
    mocks.alias.findMany.mockResolvedValue([])
    mocks.skill.findFirst.mockResolvedValue(null)
    await expect(continueLegacyAvatar(plan, true)).rejects.toThrow()
    expect(mocks.task.updateMany).not.toHaveBeenCalled()
  })
  it('does not register aliases or mirror when the task CAS loses', async () => {
    mocks.task.updateMany.mockResolvedValue({ count: 0 })
    await expect(continueLegacyAvatar(plan, true)).rejects.toThrow('TASK_CAS_LOST')
    expect(mocks.alias.create).not.toHaveBeenCalled()
    expect(mocks.mirror).not.toHaveBeenCalled()
  })
  it('requires explicit reviewed approval and rejects unknown manifest fields', async () => {
    await expect(continueLegacyAvatar({ ...plan, approval: '' }, true)).rejects.toThrow()
    await expect(continueLegacyAvatar({ ...plan, alias: 'untrusted' }, true)).rejects.toThrow()
    expect(mocks.task.findUnique).not.toHaveBeenCalled()
  })

  it.each([
    { currentJob: null }, { selection: null }, { currentJob: { ...model.currentJob, status: 'pending' } },
    { currentJob: { ...model.currentJob, url: 'https://example.invalid/different' } },
    { selection: { ...model.selection, currentJobId: 'different' } },
    { selection: { ...model.selection, variant: null } },
  ])('variants preflight rejects incomplete or inconsistent model %j before writes', async patch => {
    mocks.variants.mockReturnValue(true)
    mocks.task.findUnique.mockResolvedValue({ ...original, ...model, ...patch })
    for (const apply of [false, true]) await expect(continueLegacyAvatar(plan, apply)).rejects.toThrow(/AVATAR_MODEL_/)
    expect(mocks.task.updateMany).not.toHaveBeenCalled()
  })
  it('variants recovery mirrors the job and updates the author display', async () => {
    mocks.variants.mockReturnValue(true)
    mocks.task.findUnique.mockResolvedValue({ ...original, ...model })
    await continueLegacyAvatar(plan)
    expect(mocks.mirrorJob).not.toHaveBeenCalled()
    await continueLegacyAvatar(plan, true)
    expect(mocks.mirrorJob).toHaveBeenCalled()
    expect(mocks.skill.update).toHaveBeenCalledWith({ where: { id: plan.authorSkillId }, data: { avatarStatus: 'ready', avatarUrl: original.url } })
  })
  it('variants author display uses the selected custom image, not the generated image', async () => {
    mocks.variants.mockReturnValue(true)
    const customUrl = 'https://example.invalid/custom.webp'
    mocks.task.findUnique.mockResolvedValue({ ...original, ...model, selection: { ...model.selection, source: 'custom', customUrl } })
    await continueLegacyAvatar(plan, true)
    expect(mocks.skill.update).toHaveBeenCalledWith({ where: { id: plan.authorSkillId }, data: { avatarStatus: 'ready', avatarUrl: customUrl } })
  })
  it('rejects the target key even when it is an alias of the same task and emits safe audit context', async () => {
    mocks.alias.findMany.mockResolvedValue([{ avatarId: plan.taskId, aliasLocalId: plan.entryId }])
    for (const apply of [false, true]) {
      const error = await continueLegacyAvatar(plan, apply).catch((error: unknown) => error)
      expect(continuationFailure(error, plan, apply)).toEqual({ dryRun: !apply, outcome: 'refused', checks: 'failed',
        approval: plan.approval, taskId: plan.taskId, entryId: plan.entryId, skillId: plan.authorSkillId, reason: 'TARGET_KEY_ALREADY_ALIAS' })
    }
    const output = JSON.stringify(continuationFailure(new Error('secret provider URL or prompt'), plan, true))
    expect(output).not.toContain('secret')
    expect(output).toContain('CONTINUATION_OPERATION_FAILED')
    expect(mocks.task.updateMany).not.toHaveBeenCalled()
  })
})
