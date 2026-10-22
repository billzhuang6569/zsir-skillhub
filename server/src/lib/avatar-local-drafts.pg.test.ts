import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { configSchema } from '../config-schema.js'
import { classicAvatarStyle } from './avatar-style-catalog.js'
import { avatarDraftInput, avatarDraftInputHash, AVATAR_DRAFT_CONFIG_VERSION } from './local-ai-tasks.js'
import type { LocalAiOutcome } from './local-avatar-drafts.js'

const postgresUrl = process.env.SKILLHUB_PG_TEST_URL
const suite = postgresUrl ? describe : describe.skip

suite('#407 local avatar drafts (isolated migrated PostgreSQL schema)', () => {
  const schema = `avatar_drafts_${randomUUID().replaceAll('-', '')}`
  const ownerId = randomUUID()
  const input = { name: 'Research', description: 'Organize research notes', scenarios: [] }
  const prompt = (classicAvatarStyle.legacy.fixedStyle + '\n' + 'A geometric composition. '.repeat(20)).trim()
  const submit = vi.fn(), ai = vi.fn()
  let admin: PrismaClient, prisma: PrismaClient, app: FastifyInstance
  let avatars: typeof import('./skill-avatars.js'), jobs: typeof import('./avatar-jobs.js')
  let drafts: typeof import('./local-avatar-drafts.js'), lock: typeof import('./mutation-lock.js')
  const config = { ...configSchema.parse(process.env), SKILLHUB_PROFILE: 'selfhost' as const,
    SKILL_AVATAR_MODEL_READS: 'variants' as const, FAL_KEY: 'mock-only-never-sent', SKILL_AVATAR_DAILY_LIMIT: 10_000 }

  beforeAll(async (): Promise<void> => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network forbidden in avatar PG tests')))
    admin = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    const url = new URL(postgresUrl!); url.searchParams.set('schema', schema)
    // A completely empty schema, all real migrations, no hand-made backfill marker.
    try {
      execFileSync(process.execPath, [fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url)),
        'migrate', 'deploy', '--schema', fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url))],
      { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'pipe' })
    } catch { throw new Error('Avatar drafts fixture migrate deploy failed') }
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    await prisma.user.create({ data: { id: ownerId, email: `${ownerId}@example.invalid`, displayName: 'Draft fixture', tokenVersion: 1 } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    vi.doMock('../config.js', () => ({ config }))
    vi.doMock('../routes/skills.js', async original => ({ ...await original<typeof import('../routes/skills.js')>(), requestConfiguredAiDraft: ai }))
    vi.doMock('./ai-settings.js', () => ({ resolveAiConfig: async (): Promise<null> => null, aiStatus: () => ({ configured: false }) }))
    vi.doMock('./fal.js', async original => ({ ...await original<typeof import('./fal.js')>(), submitFalAvatar: submit,
      pollFalAvatar: vi.fn(), downloadFalAvatar: vi.fn(), findSubmittedFalAvatar: vi.fn() }))
    vi.doMock('./instance-identity.js', () => ({ getInstanceIdentity: () => ({ id: 'test-instance' }) }))
    vi.doMock('../middleware/auth.js', () => ({ authMiddleware: async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      request.user = { id: ownerId, email: '', displayName: '', marketplaceRole: 'user' }
      request.verifiedAuthToken = { sub: ownerId, ver: 1 }
    } }))
    avatars = await import('./skill-avatars.js'); jobs = await import('./avatar-jobs.js')
    drafts = await import('./local-avatar-drafts.js'); lock = await import('./mutation-lock.js')
    app = Fastify(); await app.register((await import('../routes/local-ai.js')).localAiRoutes, { prefix: '/api/local-ai' })
  }, 120_000)

  afterAll(async (): Promise<void> => {
    await app?.close(); await prisma?.$disconnect()
    if (admin) { await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.$disconnect() }
    vi.doUnmock('../db.js'); vi.doUnmock('../config.js'); vi.doUnmock('../routes/skills.js'); vi.doUnmock('./ai-settings.js')
    vi.doUnmock('./fal.js'); vi.doUnmock('./instance-identity.js'); vi.doUnmock('../middleware/auth.js'); vi.resetModules(); vi.unstubAllGlobals()
  })
  beforeEach(() => { submit.mockReset().mockImplementation(async (): Promise<string> => randomUUID()); ai.mockReset() })

  it('passes the selfhost variants startup gate immediately after migrate deploy on an empty schema', async (): Promise<void> => {
    expect(await prisma.skillAvatar.count()).toBe(0)
    const verifier = await import('./avatar-model-verification.js')
    await expect(verifier.assertAvatarReadModeAvailable(config.SKILL_AVATAR_MODEL_READS)).resolves.toBeUndefined()
  })

  async function fixture(live = true) {
    const anchor = await avatars.ensureSkillAvatar({ ownerId, localSkillId: randomUUID(), input })
    const jobId = anchor.currentJobId!
    await prisma.$transaction(async tx => {
      await lock.lockUserMutation(tx, ownerId)
      await tx.avatarGenerationJob.update({ where: { id: jobId }, data: { status: 'drafting', draftDeadline: new Date(Date.now() - 1000),
        nextAttemptAt: new Date(Date.now() - 1000), leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 180_000) } })
      await jobs.mirrorAvatarJob(tx, anchor.id)
    })
    const job = await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: jobId } })
    const inputHash = avatarDraftInputHash(jobId, classicAvatarStyle, avatarDraftInput(input, classicAvatarStyle)!)
    const lease = await prisma.localAiLease.create({ data: { userId: ownerId, avatarJobId: jobId, type: 'draftAvatarPrompt',
      inputHash, configVersion: AVATAR_DRAFT_CONFIG_VERSION, tokenVersion: 1, state: 'leased',
      expiresAt: new Date(Date.now() + (live ? 180_000 : -1000)) } })
    const task = { ...await jobs.readAvatarTask(prisma, anchor.id), ...job, job }
    const result = { inputHash, configVersion: AVATAR_DRAFT_CONFIG_VERSION, prompt }
    return { anchor, job, lease, task, result }
  }
  const post = (id: string, payload: object): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'POST', url: `/api/local-ai/leases/${id}/result`, payload })

  it('races a live local result against expiry fallback: only local wins, and submission occurs exactly once', async (): Promise<void> => {
    const f = await fixture()
    const [response] = await Promise.all([post(f.lease.id, f.result), avatars.processAvatar(f.task)])
    expect(response.statusCode).toBe(200)
    const local = await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: f.job.id } })
    expect(local).toMatchObject({ status: 'queued', promptSource: 'local', path: 'meta', submittedAt: null, draftDeadline: null })
    expect(submit).not.toHaveBeenCalled()
    const queued = { ...await jobs.readAvatarTask(prisma, f.anchor.id), ...local, job: local }
    // Even duplicate workers presenting the same snapshot cannot both consume submission.
    await Promise.all([avatars.processAvatar(queued), avatars.processAvatar(queued)])
    expect(submit).toHaveBeenCalledTimes(1)
    expect(await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: 'awaiting', path: 'meta', promptSource: 'local' })
    expect(ai).not.toHaveBeenCalled()
  })

  it('keeps a live lease past the draft deadline and preserves its wakeup through worker release', async (): Promise<void> => {
    const f = await fixture()
    await avatars.runClaimedAvatar(f.task, app.log)
    const job = await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: f.job.id } })
    expect(job).toMatchObject({ status: 'drafting', nextAttemptAt: f.lease.expiresAt, leaseToken: null, leaseUntil: null })
    expect(submit).not.toHaveBeenCalled()
    await prisma.localAiLease.delete({ where: { id: f.lease.id } })
    await prisma.avatarGenerationJob.update({ where: { id: job.id }, data: { status: 'cancelled' } })
    await jobs.mirrorAvatarJob(prisma, f.anchor.id)
  })

  it('worker wins after lease expiry; concurrent late results in submitting and awaiting return 409 without another payment', async (): Promise<void> => {
    const f = await fixture(false)
    let started!: () => void, finish!: (id: string) => void
    const submitting = new Promise<void>(resolve => { started = resolve })
    submit.mockImplementationOnce((): Promise<string> => { started(); return new Promise(resolve => { finish = resolve }) })
    const worker = avatars.processAvatar(f.task)
    await submitting
    const before = await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: f.job.id } })
    expect(before).toMatchObject({ status: 'submitting', path: 'direct', promptSource: 'direct' })
    const late = await post(f.lease.id, f.result)
    expect(late.statusCode).toBe(409); expect(late.json().code).toBe('LEASE_STALE')
    expect(await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: f.job.id } })).toEqual(before)
    finish(randomUUID()); await worker
    const awaiting = await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: f.job.id } })
    expect((await post(f.lease.id, f.result)).statusCode).toBe(409)
    expect(await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: f.job.id } })).toEqual(awaiting)
    expect(submit).toHaveBeenCalledTimes(1); expect(ai).not.toHaveBeenCalled()
  })

  it('local claim and worker downgrade serialize on the owner lock; lease IDs rotate', async (): Promise<void> => {
    const f = await fixture(false)
    const claim = (): Promise<LocalAiOutcome | null> => prisma.$transaction(async tx => {
      await lock.lockUserMutation(tx, ownerId)
      return drafts.claimAvatarDraft(tx, ownerId, 1, 'test-instance')
    })
    const [claimed] = await Promise.all([claim(), avatars.processAvatar(f.task)])
    const job = await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: f.job.id } })
    if (job.status === 'drafting') {
      expect(claimed?.status).toBe(200); expect(submit).not.toHaveBeenCalled()
      const lease = await prisma.localAiLease.findUniqueOrThrow({ where: { avatarJobId_type: { avatarJobId: job.id, type: 'draftAvatarPrompt' } } })
      expect(lease.id).not.toBe(f.lease.id)
      expect((await post(f.lease.id, f.result)).statusCode).toBe(404)
      expect((await post(lease.id, f.result)).statusCode).toBe(200)
      const queued = await jobs.readAvatarTask(prisma, f.anchor.id); await avatars.processAvatar(queued)
    } else { expect(job.status).toBe('awaiting'); expect(claimed).toBeNull() }
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('cascades draft leases when a job is removed and enforces target/active-job constraints', async (): Promise<void> => {
    const f = await fixture()
    await expect(prisma.localAiLease.create({ data: { userId: ownerId, type: 'analyzeSkill', avatarJobId: f.job.id,
      inputHash: 'a'.repeat(64), configVersion: 'test', tokenVersion: 1, state: 'leased', expiresAt: new Date() } })).rejects.toThrow()
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...copy } = f.job
    await expect(prisma.avatarGenerationJob.create({ data: { ...copy, input, falParameters: classicAvatarStyle.fal.meta.parameters,
      generationRevision: 2, idempotencyKey: randomUUID() } })).rejects.toThrow()
    await prisma.$transaction(async tx => {
      await tx.skillAvatar.update({ where: { id: f.anchor.id }, data: { currentJobId: null } })
      await tx.avatarSelection.deleteMany({ where: { logicalSkillId: f.anchor.id } })
      await tx.skillAvatarGenerationAttempt.deleteMany({ where: { jobId: f.job.id } })
      await tx.avatarGenerationJob.delete({ where: { id: f.job.id } })
    })
    expect(await prisma.localAiLease.findUnique({ where: { id: f.lease.id } })).toBeNull()
  })
})
