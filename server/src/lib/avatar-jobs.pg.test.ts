import { createHash, randomUUID } from 'node:crypto'
import { PrismaClient, Prisma } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { canonicalJson, classicAvatarStyle, contentSha256 } from './avatar-style-catalog.js'
import type { AvatarTask } from './avatar-jobs.js'

const postgresUrl = process.env.SKILLHUB_PG_TEST_URL
const suite = postgresUrl ? describe : describe.skip
suite('variants jobs, selection revisions and quota (PostgreSQL)', () => {
  const owners = [randomUUID(), randomUUID()]
  const ownerId = owners[0]
  const styleId = `qa-${randomUUID()}`
  let prisma: PrismaClient
  let avatars: typeof import('./skill-avatars.js')
  let jobs: typeof import('./avatar-jobs.js')
  let ops: typeof import('../ops/skill-avatars.js')
  const draft = vi.fn(), submit = vi.fn(), upload = vi.fn(), history = vi.fn()
  const config = { SKILL_AVATAR_MODEL_READS: 'variants', SKILLHUB_PROFILE: 'selfhost', FAL_KEY: 'mock-only', SKILL_AVATARS_ENABLED: true, SKILL_AVATAR_DAILY_LIMIT: 10_000 }
  const input = { name: 'Research', description: 'Organize useful information', scenarios: [] }
  const customUrl = 'https://picem-media.whatonearth.work/qa-custom.png'
  const generatedUrl = 'https://picem-media.whatonearth.work/qa-generated.jpg'
  const png = Buffer.alloc(33)
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(png)
  png.writeUInt32BE(13,8); png.write('IHDR',12); png.writeUInt32BE(256,16); png.writeUInt32BE(256,20)
  const image = { mimeType: 'image/png' as const, dataBase64: png.toString('base64') }
  let previousSetting: Awaited<ReturnType<PrismaClient['serverSetting']['findUnique']>>
  let rejectMirrorFor: string | null = null
  const key = (localSkillId: string) => ({ ownerId, localSkillId, input })

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    prisma.$use(async (params, next) => {
      if (rejectMirrorFor && params.model === 'SkillAvatar' && params.action === 'update' && params.args.where.id === rejectMirrorFor) throw new Error('injected mirror rejection')
      return next(params)
    })
    vi.doMock('../db.js', () => ({ db: prisma }))
    vi.doMock('../config.js', () => ({ config }))
    vi.doMock('../routes/skills.js', () => ({ requestConfiguredAiDraft: draft }))
    vi.doMock('./ai-settings.js', () => ({ resolveAiConfig: async (): Promise<object> => ({}) }))
    vi.doMock('./fal.js', async original => ({ ...await original<typeof import('./fal.js')>(), submitFalAvatar: submit, findSubmittedFalAvatar: history }))
    vi.doMock('./media.js', () => ({ uploadMedia: upload, publicImageUrl: (url: string): string => url }))
    avatars = await import('./skill-avatars.js'); jobs = await import('./avatar-jobs.js'); ops = await import('../ops/skill-avatars.js')
    await prisma.user.createMany({ data: owners.map(id => ({ id, email: `${id}@example.invalid`, displayName: 'Avatar phase B QA' })) })
    previousSetting = await prisma.serverSetting.findUnique({ where: { key: 'avatar.style' } })
    await prisma.serverSetting.upsert({ where: { key: 'avatar.style' }, create: { key: 'avatar.style', value: { styleId: 'classic' } }, update: { value: { styleId: 'classic' } } })
    upload.mockResolvedValue({ assetId: 'qa-custom', url: customUrl })
    draft.mockResolvedValue('A square illustration of leaves and ribbons. '.repeat(10) + classicAvatarStyle.legacy.fixedStyle)
    submit.mockImplementation(async () => randomUUID())
  })
  afterAll(async () => {
    if (!prisma) return
    const mine = { ownerId: { in: owners } }
    await prisma.marketplaceListing.deleteMany({ where: { skill: { authorId: { in: owners } } } })
    await prisma.avatarSelection.deleteMany({ where: mine })
    await prisma.skillAvatarGenerationAttempt.deleteMany({ where: { avatar: mine } })
    await prisma.skillAvatar.updateMany({ where: mine, data: { currentJobId: null } })
    await prisma.avatarVariant.deleteMany({ where: mine })
    await prisma.avatarGenerationJob.deleteMany({ where: mine })
    await prisma.skillAvatar.deleteMany({ where: mine })
    await prisma.skill.deleteMany({ where: { authorId: { in: owners } } })
    await prisma.user.deleteMany({ where: { id: { in: owners } } })
    // Immutable style versions stay in place; the per-run UUID isolates these fixtures.
    if (previousSetting) await prisma.serverSetting.update({ where: { key: 'avatar.style' }, data: { ...previousSetting, value: previousSetting.value ?? Prisma.JsonNull } })
    else await prisma.serverSetting.deleteMany({ where: { key: 'avatar.style' } })
    await prisma.$disconnect()
    vi.unstubAllGlobals()
  })

  async function task(id: string): Promise<AvatarTask> { return jobs.readAvatarTask(prisma, id) }
  async function lease(id: string): Promise<AvatarTask> {
    const current = await task(id)
    await prisma.$transaction(async tx => {
      await tx.avatarGenerationJob.update({ where: { id: current.job!.id }, data: { leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000) } })
      await jobs.mirrorAvatarJob(tx, id)
    })
    return task(id)
  }
  async function transferring(id: string): Promise<AvatarTask> {
    const current = await lease(id)
    expect(await jobs.persistAvatarJob(current, { status: 'submitting', path: 'meta', prompt: 'Fixture paid request', submittedAt: new Date() })).toBe(true)
    expect(await jobs.persistAvatarJob(current, { status: 'transferring', requestId: randomUUID(), assetId: 'qa-generated', url: generatedUrl })).toBe(true)
    return task(id)
  }
  async function finish(current: AvatarTask): Promise<void> { await avatars.processAvatar(current) }

  it('concurrent enqueue shares one Job/attempt; quota rollback leaves no anchor', async () => {
    const rows = await Promise.all(Array.from({ length: 8 }, () => avatars.ensureSkillAvatar(key('concurrent'))))
    expect(new Set(rows.map(row => row.id)).size).toBe(1)
    expect(await prisma.avatarGenerationJob.count({ where: { logicalSkillId: rows[0].id } })).toBe(1)
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: rows[0].id } })).toBe(1)
    config.SKILL_AVATAR_DAILY_LIMIT = await prisma.skillAvatarGenerationAttempt.count({ where: { day: avatars.utcDay(new Date()), releasedAt: null } })
    await expect(avatars.ensureSkillAvatar(key('over-quota'))).rejects.toMatchObject({ code: 'AVATAR_DAILY_QUOTA' })
    expect(await prisma.skillAvatar.count({ where: { ownerId, localSkillId: 'over-quota' } })).toBe(0)
    config.SKILL_AVATAR_DAILY_LIMIT = 10_000
  })

  it('queued upload refunds exactly its Job; restore creates a fresh paid revision and retains custom references', async () => {
    const first = await avatars.ensureSkillAvatar(key('refund'))
    await avatars.uploadCustomAvatar({ ...key('refund'), image })
    const refunded = await prisma.skillAvatarGenerationAttempt.findFirstOrThrow({ where: { avatarId: first.id } })
    expect(refunded.releasedAt).not.toBeNull()
    const oldJob = refunded.jobId
    const restored = await avatars.restoreGeneratedAvatar(ownerId, { localSkillId: 'refund' })
    expect(restored.currentJobId).not.toBe(oldJob)
    const attempts = await prisma.skillAvatarGenerationAttempt.findMany({ where: { avatarId: first.id }, orderBy: { createdAt: 'asc' } })
    expect(attempts).toHaveLength(2)
    expect(attempts.filter(row => !row.releasedAt).map(row => row.jobId)).toEqual([restored.currentJobId])
    expect((await task(first.id)).selection).toMatchObject({ source: 'generated', customUrl })
    const count = await prisma.skillAvatarGenerationAttempt.count()
    await avatars.uploadCustomAvatar({ ...key('upload-only'), image })
    expect(await prisma.skillAvatarGenerationAttempt.count()).toBe(count)
  })

  it.each(['restore-before-ready', 'ready-before-restore'])('%s reauthorizes only the current Job; global Skill columns stay frozen', async order => {
    const skill = await prisma.skill.create({ data: { authorId: ownerId, name: order, displayName: order, avatarUrl: 'frozen', avatarStatus: 'failed' } })
    const anchor = await avatars.ensureSkillAvatar({ ...key(order), skillId: skill.id })
    const current = await transferring(anchor.id)
    await avatars.uploadCustomAvatar({ ...key(order), skillId: skill.id, image })
    const attempt = await prisma.skillAvatarGenerationAttempt.findFirstOrThrow({ where: { avatarId: anchor.id } })
    expect(attempt.releasedAt).toBeNull()
    if (order === 'restore-before-ready') await avatars.restoreGeneratedAvatar(ownerId, { skillId: skill.id })
    await finish(current)
    if (order === 'ready-before-restore') {
      expect(avatars.avatarDto(await task(anchor.id))).toMatchObject({ avatarUrl: customUrl, avatarSource: 'custom' })
      await avatars.restoreGeneratedAvatar(ownerId, { skillId: skill.id })
    }
    expect(avatars.avatarDto(await task(anchor.id))).toMatchObject({ avatarUrl: generatedUrl, avatarStatus: 'ready', avatarSource: 'generated' })
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).toMatchObject({ avatarUrl: 'frozen', avatarStatus: 'failed' })
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: anchor.id } })).toBe(1)
  })

  it('late A stores history without replacing B selection intent', async () => {
    const anchor = await avatars.ensureSkillAvatar(key('late-result'))
    const current = await transferring(anchor.id)
    await prisma.avatarSelection.update({ where: { ownerId_logicalSkillId: { ownerId, logicalSkillId: anchor.id } }, data: { revision: { increment: 1 } } })
    await finish(current)
    expect(await prisma.avatarVariant.count({ where: { jobId: current.job!.id } })).toBe(1)
    expect((await prisma.avatarSelection.findUniqueOrThrow({ where: { ownerId_logicalSkillId: { ownerId, logicalSkillId: anchor.id } } })).variantId).toBeNull()
  })

  it('same Job submits once even when two completions race; unknown submission never retries paid', async () => {
    const anchor = await avatars.ensureSkillAvatar(key('single-submit'))
    const current = await lease(anchor.id)
    submit.mockClear()
    await Promise.all([avatars.processAvatar(current), avatars.processAvatar(current)])
    expect(submit).toHaveBeenCalledTimes(1)
    const unknown = await avatars.ensureSkillAvatar(key('unknown-submit'))
    const claimed = await lease(unknown.id)
    submit.mockRejectedValueOnce(new Error('network response lost'))
    await avatars.processAvatar(claimed)
    expect((await task(unknown.id)).status).toBe('needs_review')
    expect((await jobs.retryAvatarJob(ownerId, unknown.id)).transitioned).toBe(false)
    expect(submit).toHaveBeenCalledTimes(2)
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: unknown.id } })).toBe(1)
  })

  it('direct fallback wins the same submit CAS against a late meta completion', async () => {
    const anchor = await avatars.ensureSkillAvatar(key('late-meta'))
    const current = await lease(anchor.id)
    let finishDraft!: (value: string) => void, began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    draft.mockImplementationOnce(() => { began(); return new Promise<string>(resolve => { finishDraft = resolve }) })
    draft.mockResolvedValueOnce(null)
    submit.mockClear()
    const late = avatars.processAvatar(current)
    await started
    await avatars.processAvatar(current)
    finishDraft('A ribbon collects leaves. '.repeat(20) + classicAvatarStyle.legacy.fixedStyle)
    await late
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][1]).toEqual(classicAvatarStyle.fal.direct)
    expect((await task(anchor.id)).job).toMatchObject({ path: 'direct', status: 'awaiting' })
  })

  it.each(['asset', 'bytes', 'request'])('failed %s delivery resumes the same Job without another ledger row', async evidence => {
    const anchor = await avatars.ensureSkillAvatar(key(`recover-${evidence}`))
    const current = await lease(anchor.id)
    await jobs.persistAvatarJob(current, { status: 'submitting', path: 'meta', prompt: `Recover ${evidence}`, submittedAt: new Date() })
    await jobs.persistAvatarJob(current, { status: 'failed', leaseToken: null, leaseUntil: null,
      ...(evidence === 'asset' ? { assetId: 'accepted', url: generatedUrl } : evidence === 'bytes' ? { imageData: Buffer.from('saved fixture bytes'), imageSha256: createHash('sha256').update('saved fixture bytes').digest('hex') } : { requestId: randomUUID() }) })
    const count = await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: anchor.id } })
    const retry = await jobs.retryAvatarJob(ownerId, anchor.id)
    expect(retry.transitioned).toBe(true)
    expect(retry.avatar.currentJobId).toBe(current.job!.id)
    expect(retry.avatar.status).toBe(evidence === 'request' ? 'awaiting' : 'transferring')
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: anchor.id } })).toBe(count)
  })

  it('a rejected compatibility mirror rolls back Job, Variant and Selection together', async () => {
    const anchor = await avatars.ensureSkillAvatar(key('atomic-mirror'))
    const current = await transferring(anchor.id)
    rejectMirrorFor = anchor.id
    try { await expect(jobs.persistAvatarJob(current, { status: 'ready' })).rejects.toThrow('injected mirror rejection') }
    finally { rejectMirrorFor = null }
    expect((await task(anchor.id)).status).toBe('transferring')
    expect(await prisma.avatarVariant.count({ where: { jobId: current.job!.id } })).toBe(0)
    expect((await prisma.avatarSelection.findUniqueOrThrow({ where: { ownerId_logicalSkillId: { ownerId, logicalSkillId: anchor.id } } })).variantId).toBeNull()
  })

  it('claims real Jobs once and mirrors their leases; expired submitting quarantines without submit', async () => {
    const anchor = await avatars.ensureSkillAvatar(key('claim'))
    await prisma.$transaction(async tx => {
      await tx.avatarGenerationJob.update({ where: { id: anchor.currentJobId! }, data: { nextAttemptAt: new Date('2000-01-01') } })
      await jobs.mirrorAvatarJob(tx, anchor.id)
    })
    const claims = await Promise.all([jobs.claimAvatarJob(['queued'], new Date('2001-01-01')), jobs.claimAvatarJob(['queued'], new Date('2001-01-01'))])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const claimed = claims.find(Boolean)!
    expect(claimed.id).toBe(anchor.currentJobId)
    expect((await prisma.skillAvatar.findUniqueOrThrow({ where: { id: anchor.id } })).leaseToken).toBe(claimed.leaseToken)
    await jobs.persistAvatarJob(claimed, { status: 'submitting', path: 'meta', prompt: 'Unknown submit', submittedAt: new Date() })
    submit.mockClear()
    await avatars.processAvatar(await task(anchor.id))
    expect(submit).not.toHaveBeenCalled()
    expect((await task(anchor.id)).status).toBe('needs_review')
  })

  it('paid retries preserve history and batch retry excludes replaced failures', async () => {
    const anchor = await avatars.ensureSkillAvatar(key('paid-retry'))
    const old = await lease(anchor.id)
    await jobs.persistAvatarJob(old, { status: 'failed', leaseToken: null, leaseUntil: null })
    await jobs.retryAvatarJob(ownerId, anchor.id)
    const next = await lease(anchor.id)
    expect(next.job!.generationRevision).toBe(2)
    await jobs.persistAvatarJob(next, { status: 'failed', leaseToken: null, leaseUntil: null })
    const preview = await ops.retryAvatars(ops.parseAvatarOperation(['retry', '--all-failed', '--limit', '200']))
    const rows = preview.tasks as Array<{ task: string }>
    expect(rows.some(row => row.task === old.job!.id)).toBe(false)
    expect(rows.some(row => row.task === next.job!.id)).toBe(true)
    expect((await jobs.retryAvatarJob(ownerId, old.job!.id, true)).transitioned).toBe(false)
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: anchor.id } })).toBe(2)
  })

  it('reconcile refuses a requestId held by a historical Job', async () => {
    const anchor = await avatars.ensureSkillAvatar(key('history-request'))
    const old = await transferring(anchor.id)
    await finish(old)
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`skillhub:user:${ownerId}`}, 0))::text`
      await jobs.createAvatarJob(tx, await tx.skillAvatar.findUniqueOrThrow({ where: { id: anchor.id } }), 'retry')
    })
    const current = await lease(anchor.id)
    await jobs.persistAvatarJob(current, { status: 'submitting', path: 'meta', prompt: 'Unique unknown history lookup', submittedAt: new Date() })
    await jobs.persistAvatarJob(current, { status: 'needs_review', leaseToken: null, leaseUntil: null })
    history.mockResolvedValue(old.requestId)
    expect(await ops.reconcileAvatar(current.job!.id, true)).toBe('ambiguous_or_claimed')
    expect((await task(anchor.id)).requestId).toBeNull()
  })

  it('style resolution follows profile and a queued Job keeps its cached version', async () => {
    const v1 = { ...classicAvatarStyle, styleId, styleVersion: 1 }
    const v2 = { ...v1, styleVersion: 2, fal: { ...v1.fal, meta: { model: 'qa/new-model', parameters: { size: 42 } } } }
    const insert = async (style: typeof v1): Promise<void> => {
      const content = canonicalJson(style)
      await prisma.avatarStyleVersion.create({ data: { styleId, styleVersion: style.styleVersion, content, contentSha256: contentSha256(content), source: 'repository' } })
    }
    await insert(v1)
    config.SKILLHUB_PROFILE = 'yitan-official'
    await prisma.user.update({ where: { id: ownerId }, data: { avatarStyleId: styleId } })
    const anchor = await avatars.ensureSkillAvatar(key('fixed-style'))
    await insert(v2)
    expect((await jobs.resolveAccountAvatarStyle(prisma, ownerId)).style.styleVersion).toBe(2)
    const current = await lease(anchor.id)
    expect(current.job).toMatchObject({ styleId, styleVersion: 1 })
    submit.mockClear()
    await avatars.processAvatar(current)
    expect(submit.mock.calls[0][1]).toEqual(v1.fal.meta)
    config.SKILLHUB_PROFILE = 'selfhost'
    expect((await jobs.resolveAccountAvatarStyle(prisma, ownerId)).style.styleId).toBe('classic')
    await prisma.serverSetting.update({ where: { key: 'avatar.style' }, data: { value: { styleId } } })
    expect((await jobs.resolveAccountAvatarStyle(prisma, ownerId)).style.styleVersion).toBe(2)
    config.SKILLHUB_PROFILE = 'yitan-official'
    await prisma.user.update({ where: { id: ownerId }, data: { avatarStyleId: null } })
    expect((await jobs.resolveAccountAvatarStyle(prisma, ownerId)).style.styleId).toBe(styleId)
    await prisma.serverSetting.update({ where: { key: 'avatar.style' }, data: { value: { styleId: 'classic' } } })
    expect((await jobs.resolveAccountAvatarStyle(prisma, ownerId)).style.styleId).toBe('classic')
    config.SKILLHUB_PROFILE = 'selfhost'
  })
})
