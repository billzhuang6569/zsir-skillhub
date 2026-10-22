import { randomUUID } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson, classicAvatarStyle, contentSha256, type AvatarStyle } from './avatar-style-catalog.js'
import type { AvatarTask } from './avatar-jobs.js'

const postgresUrl = process.env.SKILLHUB_PG_TEST_URL
const suite = postgresUrl ? describe : describe.skip
suite('#408 style apply and ledger (PostgreSQL, mocked fal)', () => {
  const ownerId = randomUUID(), otherId = randomUUID(), owners = [ownerId, otherId]
  const styleA = { ...classicAvatarStyle, styleId: `qa-a-${randomUUID()}` }
  const styleB = { ...classicAvatarStyle, styleId: `qa-b-${randomUUID()}` }
  const styleC = { ...classicAvatarStyle, styleId: `qa-c-${randomUUID()}` }
  const config = { SKILL_AVATAR_MODEL_READS: 'variants', SKILLHUB_PROFILE: 'yitan-official', FAL_KEY: 'mock-key-only',
    SKILL_AVATARS_ENABLED: true, SKILL_AVATAR_DAILY_LIMIT: 100_000 }
  const network = vi.fn(() => { throw new Error('No real fal or media requests allowed') })
  const mine = { ownerId: { in: owners } }
  const input = { name: 'Switch QA', description: 'Style switching fixture', scenarios: [] }
  let prisma: PrismaClient
  let avatars: typeof import('./skill-avatars.js')
  let jobs: typeof import('./avatar-jobs.js')
  let switching: typeof import('./avatar-style-switch.js')
  let locks: typeof import('./mutation-lock.js')
  let settings: typeof import('./server-settings.js')
  let verifier: typeof import('./avatar-model-verification.js')
  let ops: typeof import('../ops/skill-avatars.js')
  let originalSetting: Awaited<ReturnType<PrismaClient['serverSetting']['findUnique']>>

  async function clear(): Promise<void> {
    await prisma.localAiLease.deleteMany({ where: { userId: { in: owners } } })
    await prisma.avatarSelection.deleteMany({ where: mine })
    await prisma.skillAvatarGenerationAttempt.deleteMany({ where: { avatar: mine } })
    await prisma.skillAvatar.updateMany({ where: mine, data: { currentJobId: null } })
    await prisma.avatarVariant.deleteMany({ where: mine })
    await prisma.avatarGenerationJob.deleteMany({ where: mine })
    await prisma.skillAvatar.deleteMany({ where: mine })
    await prisma.skill.deleteMany({ where: { authorId: { in: owners } } })
  }
  async function seedStyle(style: AvatarStyle): Promise<void> {
    const content = canonicalJson(style)
    await prisma.avatarStyleVersion.create({ data: { styleId: style.styleId, styleVersion: style.styleVersion,
      content, contentSha256: contentSha256(content), source: 'repository' } })
  }
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    vi.doMock('../config.js', () => ({ config }))
    vi.doMock('./fal.js', async original => ({ ...await original<typeof import('./fal.js')>(),
      submitFalAvatar: network, pollFalAvatar: network, findSubmittedFalAvatar: network, downloadFalAvatar: network }))
    vi.stubGlobal('fetch', network)
    avatars = await import('./skill-avatars.js'); jobs = await import('./avatar-jobs.js')
    switching = await import('./avatar-style-switch.js'); locks = await import('./mutation-lock.js')
    settings = await import('./server-settings.js'); verifier = await import('./avatar-model-verification.js')
    ops = await import('../ops/skill-avatars.js')
    await prisma.user.createMany({ data: owners.map(id => ({ id, email: `${id}@example.invalid`, displayName: 'Style switch QA', avatarStyleId: styleA.styleId })) })
    originalSetting = await prisma.serverSetting.findUnique({ where: { key: 'avatar.style' } })
    for (const style of [styleA, styleB, styleC]) await seedStyle(style)
  })
  beforeEach(async () => {
    await clear()
    config.SKILLHUB_PROFILE = 'yitan-official'; config.SKILL_AVATAR_DAILY_LIMIT = 100_000
    await prisma.user.updateMany({ where: { id: { in: owners } }, data: { avatarStyleId: styleA.styleId } })
    await settings.writeServerSetting('avatar.style', { value: { styleId: styleA.styleId } }, ownerId)
    network.mockClear()
  })
  afterAll(async () => {
    if (!prisma) return
    await clear()
    if (originalSetting) await prisma.serverSetting.update({ where: { key: 'avatar.style' }, data: { ...originalSetting, value: originalSetting.value ?? Prisma.JsonNull } })
    else await prisma.serverSetting.deleteMany({ where: { key: 'avatar.style' } })
    await prisma.user.deleteMany({ where: { id: { in: owners } } })
    // Immutable catalog rows are isolated by per-run UUIDs, as in the existing PG suites.
    await prisma.$disconnect()
    vi.unstubAllGlobals()
  })
  async function anchor(name: string, owner = ownerId): Promise<AvatarTask> {
    const created = await avatars.ensureSkillAvatar({ ownerId: owner, localSkillId: name, input })
    return jobs.readAvatarTask(prisma, created.id)
  }
  async function submitted(task: AvatarTask): Promise<AvatarTask> {
    await jobs.persistAvatarJob(task, { status: 'submitting', path: 'meta', prompt: 'Fixture prompt', submittedAt: new Date() })
    await jobs.persistAvatarJob(task, { status: 'awaiting', requestId: randomUUID() })
    return jobs.readAvatarTask(prisma, task.id)
  }
  async function finish(task: AvatarTask): Promise<void> {
    await jobs.persistAvatarJob(task, { status: 'ready', path: 'meta', assetId: `asset-${task.job!.id}`,
      url: `https://example.invalid/${task.job!.id}.jpg` })
  }
  async function selectCustom(task: AvatarTask): Promise<void> {
    await prisma.$transaction(async tx => {
      await locks.lockUserMutation(tx, task.ownerId)
      await jobs.selectCustomAvatar(tx, task, { customAssetId: 'custom', customUrl: 'https://example.invalid/custom.png', customUpdatedAt: new Date() })
    })
  }
  const apply = (style: AvatarStyle, includeCustom = false) => switching.applyAvatarStyle(ownerId,
    { styleId: style.styleId, mode: 'applyExisting', includeCustom })

  it('A→B→A reuses A without paying, late B only enters history, and custom restore still works', async () => {
    const first = await submitted(await anchor('round-trip'))
    await finish(first)
    expect(await apply(styleB)).toMatchObject({ queued: 1, reused: 0 })
    const b = await submitted(await jobs.readAvatarTask(prisma, first.id))
    const count = await prisma.avatarGenerationJob.count({ where: mine })
    const attemptCount = await prisma.skillAvatarGenerationAttempt.count({ where: { avatar: mine } })
    expect(await apply(styleA)).toMatchObject({ queued: 0, reused: 1, cancelledUnsubmitted: 0 })
    const before = await prisma.avatarSelection.findUniqueOrThrow({ where: { ownerId_logicalSkillId: { ownerId, logicalSkillId: first.id } } })
    expect(before.currentJobId).toBe(first.job!.id)
    expect(before.revision).toBeGreaterThan(b.job!.selectionRevision)
    await finish(b)
    expect(await prisma.avatarSelection.findUniqueOrThrow({ where: { ownerId_logicalSkillId: { ownerId, logicalSkillId: first.id } } })).toEqual(before)
    expect(await prisma.avatarVariant.count({ where: mine })).toBe(2)
    expect(await prisma.avatarGenerationJob.count({ where: mine })).toBe(count)
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatar: mine } })).toBe(attemptCount)
    expect(avatars.avatarDto(await jobs.readAvatarTask(prisma, first.id)).avatarUrl).toBe(`https://example.invalid/${first.job!.id}.jpg`)
    await selectCustom(await jobs.readAvatarTask(prisma, first.id))
    expect(avatars.avatarDto(await avatars.restoreGeneratedAvatar(ownerId, { localSkillId: 'round-trip' })).avatarUrl).toBe(`https://example.invalid/${first.job!.id}.jpg`)
    expect(await prisma.avatarGenerationJob.count({ where: mine })).toBe(count)
    // C has no image: choose the latest historical B at the time of apply.
    expect(await apply(styleC)).toMatchObject({ queued: 1 })
    expect(avatars.avatarDto(await jobs.readAvatarTask(prisma, first.id)).avatarUrl).toBe(`https://example.invalid/${b.job!.id}.jpg`)
    expect(network).not.toHaveBeenCalled()
  })

  it('concurrent apply creates one target job/attempt and reattaches an existing target without duplication', async () => {
    const first = await submitted(await anchor('race'))
    const results = await Promise.all([apply(styleB), apply(styleB)])
    expect(results.reduce((sum, result) => sum + result.queued, 0)).toBe(1)
    expect(await prisma.avatarGenerationJob.count({ where: { ...mine, styleId: styleB.styleId } })).toBe(1)
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatar: mine } })).toBe(2)
    const b = await jobs.readAvatarTask(prisma, first.id)
    const selection = await prisma.avatarSelection.findUniqueOrThrow({ where: { ownerId_logicalSkillId: { ownerId, logicalSkillId: first.id } } })
    expect(selection.currentJobId).toBe(b.job!.id); expect(selection.revision).toBe(b.job!.selectionRevision)
    expect((await verifier.verifyAvatarModel()).counts['mismatch.activeUnique'] ?? 0).toBe(0)
    await verifier.assertAvatarReadModeAvailable('variants')
    await finish(b)
    expect(avatars.avatarDto(await jobs.readAvatarTask(prisma, first.id)).avatarUrl).toBe(`https://example.invalid/${b.job!.id}.jpg`)
  })

  it.each(['queued', 'drafting'])('cancels unleased %s old work and refunds only its linked attempt before reserving', async status => {
    const first = await anchor(`cancel-${status}`)
    if (status === 'drafting') await jobs.persistAvatarJob(first, { status: 'drafting', draftDeadline: new Date(Date.now() + 60_000) })
    const before = await avatars.avatarQuotaToday()
    config.SKILL_AVATAR_DAILY_LIMIT = before.used
    expect(await apply(styleB)).toMatchObject({ cancelledUnsubmitted: 1, queued: 1, deferredByQuota: 0 })
    expect(await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: first.job!.id } })).toMatchObject({ status: 'cancelled' })
    expect((await prisma.skillAvatarGenerationAttempt.findUniqueOrThrow({ where: { jobId: first.job!.id } })).releasedAt).not.toBeNull()
    expect((await avatars.avatarQuotaToday()).used).toBe(before.used)
  })

  it('protects custom by default, includes it explicitly, and defers missing images without retaining old display intent', async () => {
    const custom = await anchor('custom')
    await selectCustom(custom)
    const first = await submitted(await anchor('quota'))
    config.SKILL_AVATAR_DAILY_LIMIT = (await avatars.avatarQuotaToday()).used
    expect(await apply(styleB)).toMatchObject({ skippedCustom: 1, queued: 0, deferredByQuota: 1 })
    const selected = await prisma.avatarSelection.findUniqueOrThrow({ where: { ownerId_logicalSkillId: { ownerId, logicalSkillId: first.id } } })
    expect(selected.currentJobId).toBeNull(); expect(selected.revision).toBeGreaterThan(first.job!.selectionRevision)
    await finish(first)
    expect((await prisma.avatarSelection.findUniqueOrThrow({ where: { ownerId_logicalSkillId: { ownerId, logicalSkillId: first.id } } })).variantId).toBeNull()
    expect(avatars.avatarDto(await jobs.readAvatarTask(prisma, first.id)).avatarUrl).toBe(`https://example.invalid/${first.job!.id}.jpg`)
    config.SKILL_AVATAR_DAILY_LIMIT = 100_000
    expect(await apply(styleB, true)).toMatchObject({ queued: 2, skippedCustom: 0 })
    expect((await jobs.readAvatarTask(prisma, custom.id)).selection?.source).toBe('generated')
  })

  it('retains leased and unknown old jobs, and other styles do not block free transfer recovery', async () => {
    const first = await submitted(await anchor('recover'))
    await jobs.persistAvatarJob(first, { status: 'needs_review' })
    const leased = await anchor('leased')
    await prisma.avatarGenerationJob.update({ where: { id: leased.job!.id }, data: { leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000) } })
    const localLease = await anchor('local-leased')
    await jobs.persistAvatarJob(localLease, { status: 'drafting', draftDeadline: new Date(Date.now() + 60_000) })
    await prisma.localAiLease.create({ data: { userId: ownerId, avatarJobId: localLease.job!.id, type: 'draftAvatarPrompt',
      inputHash: 'a'.repeat(64), configVersion: 'qa', tokenVersion: 0, state: 'leased', expiresAt: new Date(Date.now() + 60_000) } })
    expect(await apply(styleB)).toMatchObject({ queued: 3, cancelledUnsubmitted: 0 })
    const b = await submitted(await jobs.readAvatarTask(prisma, first.id))
    await jobs.persistAvatarJob(b, { status: 'failed', assetId: 'accepted', url: 'https://example.invalid/accepted.jpg' })
    const preview = await ops.retryAvatars(ops.parseAvatarOperation(['retry', '--task', b.job!.id]))
    expect(preview.tasks).toEqual([expect.objectContaining({ task: b.job!.id, target: 'transferring', chargesAttempt: false })])
    const before = await prisma.skillAvatarGenerationAttempt.count({ where: { avatar: mine } })
    expect((await jobs.retryAvatarJob(ownerId, b.job!.id, true)).transitioned).toBe(true)
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatar: mine } })).toBe(before)
    expect(await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: first.job!.id } })).toMatchObject({ status: 'needs_review' })
  })

  it('official scope changes only the owner; instance newOnly and applyExisting cover each owner but exclude foreign cloud skills', async () => {
    const own = await anchor('own'), other = await anchor('other', otherId)
    expect(await apply(styleB)).toMatchObject({ queued: 1, cancelledUnsubmitted: 1 })
    expect((await jobs.readAvatarTask(prisma, other.id)).job!.styleId).toBe(styleA.styleId)
    const foreignSkill = await prisma.skill.create({ data: { authorId: otherId, name: 'foreign', displayName: 'Foreign' } })
    const foreign = await anchor('foreign-anchor')
    await prisma.skillAvatar.update({ where: { id: foreign.id }, data: { skillId: foreignSkill.id } })
    config.SKILLHUB_PROFILE = 'selfhost'
    const before = await prisma.avatarGenerationJob.count({ where: mine })
    expect(await switching.applyAvatarStyle(ownerId, { styleId: styleC.styleId, mode: 'newOnly' })).toMatchObject({ queued: 0, reused: 0 })
    expect(await prisma.avatarGenerationJob.count({ where: mine })).toBe(before)
    expect((await jobs.resolveAccountAvatarStyle(prisma, otherId)).style.styleId).toBe(styleC.styleId)
    expect(await apply(styleC)).toMatchObject({ queued: 2, cancelledUnsubmitted: 2 })
    for (const id of [own.id, other.id]) expect((await jobs.readAvatarTask(prisma, id)).job!.styleId).toBe(styleC.styleId)
    expect((await jobs.readAvatarTask(prisma, foreign.id)).job!.id).toBe(foreign.job!.id)
  })

  it('reuses a successful older style version and restores custom after a quota-deferred switch', async () => {
    const first = await submitted(await anchor('older-version'))
    await finish(first)
    await seedStyle({ ...styleA, styleVersion: 2 })
    expect(await apply(styleA)).toMatchObject({ styleVersion: 2, reused: 1, queued: 0 })
    expect((await jobs.readAvatarTask(prisma, first.id)).job!.styleVersion).toBe(1)
    config.SKILL_AVATAR_DAILY_LIMIT = (await avatars.avatarQuotaToday()).used
    expect(await apply(styleB)).toMatchObject({ queued: 0, deferredByQuota: 1 })
    expect((await prisma.avatarSelection.findUniqueOrThrow({ where: { ownerId_logicalSkillId: { ownerId, logicalSkillId: first.id } } })).currentJobId).toBeNull()
    await selectCustom(await jobs.readAvatarTask(prisma, first.id))
    expect(avatars.avatarDto(await avatars.restoreGeneratedAvatar(ownerId, { localSkillId: 'older-version' })).avatarUrl).toBe(`https://example.invalid/${first.job!.id}.jpg`)
    expect(await prisma.avatarGenerationJob.count({ where: mine })).toBe(1)
  })
})
