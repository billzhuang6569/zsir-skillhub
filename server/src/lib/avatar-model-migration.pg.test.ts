import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mirrorSkillAvatar } from './avatar-model.js'
import { SKILL_ART_FIXED_STYLE } from './skill-avatar-prompt.js'

const postgresUrl = process.env.SKILLHUB_PG_TEST_URL
const migrations = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url))
const expand = '20261018130000_avatar_model_expand', backfill = '20261018140000_avatar_model_backfill'
const describePostgres = postgresUrl ? describe : describe.skip

describePostgres('avatar model expand/backfill and legacy transactions (PostgreSQL)', () => {
  const schema = `avatar_model_${randomUUID().replaceAll('-', '')}`, ownerId = randomUUID()
  const now = new Date('2026-10-18T00:00:00.000Z'), input = { name: 'Fixture', description: 'Avatar migration fixture', scenarios: [] }
  const ids = new Map<string, string>()
  let admin: PrismaClient, prisma: PrismaClient, directory: string, databaseUrl: string
  let upgraded = false
  let avatars: typeof import('./skill-avatars.js'), verifier: typeof import('./avatar-model-verification.js')
  const upload = vi.fn().mockResolvedValue({ assetId: 'ast_custom', url: 'https://picem-media.whatonearth.work/custom.png' })
  const draft = vi.fn(), submit = vi.fn().mockImplementation(async (): Promise<string> => randomUUID())
  const execute = (file: string): void => {
    // The connection string is only in the child environment, never argv or test output.
    try {
      execFileSync(process.execPath, [fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url)),
        'db', 'execute', '--schema', fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)), '--file', file],
      { env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' })
    } catch (error: unknown) {
      const stderr = error && typeof error === 'object' && 'stderr' in error ? error.stderr : undefined
      const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : typeof stderr === 'string' ? stderr : ''
      // Redact before truncating: neither an exact URL nor another PostgreSQL
      // connection URI emitted by the CLI may leak through the diagnostic.
      const summary = detail.replaceAll(databaseUrl, '[DATABASE_URL]')
        .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[DATABASE_URL]').trim().slice(0, 2000)
      throw new Error(`Avatar fixture migration rejected${summary ? `: ${summary}` : ''}`)
    }
  }
  const applyLaterMigrations = (): void => {
    if (upgraded) return
    for (const name of readdirSync(migrations).filter(name => /^\d{14}_/.test(name) && name > backfill).sort()) {
      execute(join(migrations, name, 'migration.sql'))
    }
    upgraded = true
  }
  const runBackfill = (upgrade = true): void => {
    // Re-run/no-op checks belong to the historical schema, never to a schema
    // whose extra columns would change the backfill's whole-row comparison.
    if (upgraded) throw new Error('Cannot replay historical backfill after later migrations')
    execute(join(migrations, backfill, 'migration.sql'))
    if (upgrade) applyLaterMigrations()
  }
  const historicalJobs = (): Promise<unknown[]> => prisma.$queryRaw`SELECT * FROM avatar_generation_jobs ORDER BY id`
  beforeEach(async (): Promise<void> => {
    vi.resetModules(); ids.clear(); upgraded = false; draft.mockReset(); submit.mockClear()
    admin = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    const url = new URL(postgresUrl!); url.searchParams.set('schema', schema); databaseUrl = url.toString()
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    directory = mkdtempSync(join(tmpdir(), 'avatar-migration-'))
    const bootstrap = join(directory, 'bootstrap.sql')
    writeFileSync(bootstrap, readdirSync(migrations).filter(name => name < expand && !name.endsWith('.toml')).sort()
      .map(name => readFileSync(join(migrations, name, 'migration.sql'), 'utf8')).join('\n'))
    execute(bootstrap)
    // Explicit-column fixture inserts stay compatible with the historical schema, independent of the current client.
    await prisma.$executeRaw`INSERT INTO users (id,email,"displayName","updatedAt") VALUES (${ownerId},${`${ownerId}@example.invalid`},'Migration QA',${now})`
    const pre = randomUUID(); ids.set('preexpand', pre)
    await prisma.$executeRaw`INSERT INTO skill_avatars (id,"ownerId","localSkillId",input,"inputFingerprint","promptVersion",status,"assetId",url,"updatedAt")
      VALUES (${pre},${ownerId},'preexpand',${JSON.stringify(input)}::jsonb,'fp','v1','ready','ast_preexpand','https://picem-media.whatonearth.work/pre.jpg',${now})`
    execute(join(migrations, expand, 'migration.sql'))
    for (const state of ['ready','queued','prompting','submitting','awaiting','transferring','failed','needs_review','cancelled','custom-ready','custom-flight','upload-only','deleted']) {
      const status = state === 'custom-ready' || state === 'deleted' ? 'ready' : state === 'custom-flight' ? 'awaiting' : state === 'upload-only' ? 'cancelled' : state
      const custom = state.startsWith('custom') || state === 'upload-only'
      const submitted = ['submitting','awaiting','transferring','needs_review'].includes(status)
      const bytes = status === 'transferring' ? Buffer.from('persisted-jpeg') : null
      let skillId: string | null = null
      if (state === 'deleted' || state === 'ready') {
        skillId = randomUUID()
        await prisma.$executeRaw`INSERT INTO skills (id,"authorId",name,"displayName","deletedAt","avatarUrl","avatarStatus","updatedAt")
          VALUES (${skillId},${ownerId},${state},${state},${state === 'deleted' ? now : null},
            ${`https://picem-media.whatonearth.work/${state}.jpg`},'ready',CURRENT_TIMESTAMP)`
      }
      const avatarId = randomUUID()
      await prisma.$executeRaw`INSERT INTO skill_avatars
        (id,"ownerId","localSkillId","skillId",input,"inputFingerprint","promptVersion",status,source,
         "customAssetId","customUrl","customUpdatedAt",prompt,"submittedAt","requestId","imageUrl","imageData","imageSha256",
         "assetId",url,"queuedAt","createdAt","updatedAt","leaseToken","leaseUntil")
        VALUES (${avatarId},${ownerId},${state},${skillId},${JSON.stringify(input)}::jsonb,'fp','v1',${status},${custom ? 'custom' : 'generated'},
          ${custom ? 'ast_custom' : null},${custom ? 'https://picem-media.whatonearth.work/custom.png' : null},${custom ? now : null},
          ${submitted || status === 'ready' ? 'Preserved private prompt' : null},${submitted ? now : null},
          ${['awaiting','transferring'].includes(status) ? randomUUID() : null},
          ${status === 'transferring' ? 'https://fal.media/private-temporary.jpg' : null},${bytes},${bytes ? createHash('sha256').update(bytes).digest('hex') : null},
          ${status === 'ready' ? 'ast_generated' : null},${status === 'ready' ? `https://picem-media.whatonearth.work/${state}.jpg` : null},
          ${state === 'upload-only' ? null : now},${now},${now},${status === 'prompting' ? 'old-lease' : null},${status === 'prompting' ? now : null})`
      ids.set(state, avatarId)
      if (state !== 'upload-only') await prisma.$executeRaw`INSERT INTO skill_avatar_generation_attempts
        (id,"avatarId",day,kind,"createdAt","releasedAt")
        VALUES (${randomUUID()},${avatarId},${now},'baseline',${now},${status === 'cancelled' ? now : null})`
    }
    // This unrelated later attempt must not be refunded when the queued Job is cancelled.
    await prisma.$executeRaw`INSERT INTO skill_avatar_generation_attempts (id,"avatarId",day,kind,"createdAt")
      VALUES (${randomUUID()},${ids.get('queued')!},${now},'retry',${new Date(now.getTime() + 1_000)})`
    await prisma.$executeRaw`INSERT INTO skill_avatar_aliases ("ownerId","aliasLocalId","avatarId")
      VALUES (${ownerId},'old-device',${ids.get('ready')!})`
    for (const withdrawn of [false, true]) {
      const skillId = randomUUID(), versionId = randomUUID(), submissionId = randomUUID(), name = `listed-${withdrawn}`
      await prisma.$executeRaw`INSERT INTO skills (id,"authorId",name,"displayName","avatarUrl","avatarStatus","updatedAt")
        VALUES (${skillId},${ownerId},${name},'Listed','https://picem-media.whatonearth.work/listing.jpg','ready',CURRENT_TIMESTAMP)`
      await prisma.$executeRaw`INSERT INTO skill_versions (id,"skillId",version) VALUES (${versionId},${skillId},'0.1.0')`
      await prisma.$executeRaw`INSERT INTO marketplace_submissions (id,"skillId","versionId","submittedById","skillName","displayName","sourceContent",status)
        VALUES (${submissionId},${skillId},${versionId},${ownerId},${name},'Listed','fixture','approved')`
      await prisma.$executeRaw`INSERT INTO marketplace_listings ("skillId","versionId","submissionId","withdrawnAt","updatedAt")
        VALUES (${skillId},${versionId},${submissionId},${withdrawn ? now : null},CURRENT_TIMESTAMP)`
    }
    vi.doMock('../db.js', () => ({ db: prisma }))
    vi.doMock('../config.js', () => ({ config: { SKILL_AVATARS_ENABLED: true, SKILL_AVATAR_DAILY_LIMIT: 1000 } }))
    vi.doMock('../routes/skills.js', () => ({ requestConfiguredAiDraft: draft }))
    vi.doMock('./fal.js', async original => ({ ...await original<typeof import('./fal.js')>(), submitFalAvatar: submit }))
    vi.doMock('./media.js', () => ({ uploadMedia: upload, publicImageUrl: (url: string): string => url }))
    avatars = await import('./skill-avatars.js'); verifier = await import('./avatar-model-verification.js')
  }, 90_000)
  afterEach(async (): Promise<void> => {
    await prisma?.$disconnect()
    if (admin) { await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.$disconnect() }
    if (directory) rmSync(directory, { recursive: true, force: true })
    vi.doUnmock('../db.js'); vi.doUnmock('../config.js'); vi.doUnmock('../routes/skills.js'); vi.doUnmock('./media.js')
    vi.doUnmock('./fal.js')
  })

  it('backfills every fixture without changing old columns, aliases, ledger or listing display; re-run is a no-op', async () => {
    const before = await prisma.skillAvatar.findMany({ orderBy: { id: 'asc' } })
    const ledger = await prisma.skillAvatarGenerationAttempt.findMany({ orderBy: { id: 'asc' } })
    const aliases = await prisma.skillAvatarAlias.findMany(), listings = await prisma.marketplaceListing.findMany()
    runBackfill(false)
    const after = await prisma.skillAvatar.findMany({ orderBy: { id: 'asc' } })
    expect(after.map(({ currentJobId: _id, ...row }) => row)).toEqual(before.map(({ currentJobId: _id, ...row }) => row))
    expect(await prisma.avatarGenerationJob.count()).toBe(before.length)
    expect(await prisma.avatarSelection.count()).toBe(before.length)
    expect(await prisma.avatarVariant.count()).toBe(4)
    expect(await prisma.skillAvatarAlias.findMany()).toEqual(aliases)
    expect((await prisma.skillAvatarGenerationAttempt.findMany({ orderBy: { id: 'asc' } })).map(({ jobId: _id, ...row }) => row))
      .toEqual(ledger.map(({ jobId: _id, ...row }) => row))
    for (const old of listings) expect(await prisma.marketplaceListing.findUnique({ where: { skillId: old.skillId } })).toMatchObject({
      avatarUrl: 'https://picem-media.whatonearth.work/listing.jpg', avatarStatus: 'ready', updatedAt: old.updatedAt, withdrawnAt: old.withdrawnAt,
    })
    const marker = await prisma.serverSetting.findUniqueOrThrow({ where: { key: 'avatar.model.backfilled' } })
    expect(marker.value).toEqual({ migration: backfill })
    const jobs = await historicalJobs()
    runBackfill(false)
    expect(await historicalJobs()).toEqual(jobs)
    expect(await prisma.serverSetting.findUnique({ where: { key: 'avatar.model.backfilled' } })).toEqual(marker)
    applyLaterMigrations()
    expect((await verifier.verifyAvatarModel()).counts.mismatches).toBe(0)
  }, 20_000)

  it('rejects ambiguous queued attempts and rolls back the entire backfill', async () => {
    runBackfill(false)
    const row = await prisma.skillAvatar.create({ data: { ownerId, localSkillId: 'ambiguous', input, inputFingerprint: 'fp', promptVersion: 'v1', queuedAt: now } })
    await prisma.skillAvatarGenerationAttempt.createMany({ data: ['create','retry'].map(kind => ({ avatarId: row.id, day: now, kind, createdAt: now })) })
    await prisma.serverSetting.delete({ where: { key: 'avatar.model.backfilled' } })
    const before = await prisma.avatarGenerationJob.count()
    expect(runBackfill).toThrow('avatar_backfill_attempt_ambiguous')
    expect(upgraded).toBe(false)
    expect(await prisma.$queryRaw`SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'avatar_generation_jobs'
        AND column_name IN ('draftDeadline', 'promptSource')`).toEqual([])
    expect(await prisma.$queryRaw`SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = 'local_ai_leases'`).toEqual([])
    expect(await prisma.avatarGenerationJob.count()).toBe(before)
    expect((await prisma.skillAvatar.findUniqueOrThrow({ where: { id: row.id } })).currentJobId).toBeNull()
    expect(await prisma.serverSetting.findUnique({ where: { key: 'avatar.model.backfilled' } })).toBeNull()
    await prisma.skillAvatar.delete({ where: { id: row.id } })
    runBackfill()
    expect((await verifier.verifyAvatarModel()).counts.mismatches).toBe(0)
  }, 20_000)

  it('database rejects variant edits, submitted intent rewrites and two active jobs', async () => {
    runBackfill()
    await expect(prisma.avatarVariant.updateMany({ data: { url: 'changed' } })).rejects.toThrow()
    const job = await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: ids.get('awaiting')! } })
    await expect(prisma.avatarGenerationJob.update({ where: { id: job.id }, data: { requestId: null } })).rejects.toThrow()
    await expect(prisma.avatarGenerationJob.update({ where: { id: job.id }, data: { prompt: 'changed' } })).rejects.toThrow()
    await expect(prisma.avatarGenerationJob.create({ data: { ...job, id: randomUUID(), requestId: null, generationRevision: 2, idempotencyKey: randomUUID() } })).rejects.toThrow()
    await expect(prisma.avatarGenerationJob.create({ data: { ...job, id: randomUUID(), status: 'failed', generationRevision: 2, idempotencyKey: randomUUID() } })).rejects.toThrow()
    await expect(prisma.avatarGenerationJob.create({ data: { ...job, id: randomUUID(), status: 'failed', requestId: null, idempotencyKey: randomUUID() } })).rejects.toThrow()
    await expect(prisma.avatarSelection.update({ where: { ownerId_logicalSkillId: { ownerId, logicalSkillId: job.logicalSkillId } }, data: { ownerId: randomUUID() } })).rejects.toThrow()
  }, 30_000)

  it('mirroring failure rolls back the legacy write in the same transaction', async () => {
    runBackfill()
    const id = ids.get('awaiting')!, before = await prisma.skillAvatar.findUniqueOrThrow({ where: { id } })
    await expect(prisma.$transaction(async tx => {
      await tx.skillAvatar.update({ where: { id }, data: { prompt: 'forbidden rewrite' } })
      await mirrorSkillAvatar(tx, id)
    })).rejects.toThrow()
    expect(await prisma.skillAvatar.findUniqueOrThrow({ where: { id } })).toEqual(before)
  }, 30_000)

  it('a migrated queued upload refunds exactly its linked attempt and restore creates a new paid Job', async () => {
    runBackfill()
    const bytes = Buffer.alloc(33); Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(bytes)
    bytes.writeUInt32BE(13,8); bytes.write('IHDR',12); bytes.writeUInt32BE(512,16); bytes.writeUInt32BE(512,20)
    const id = ids.get('queued')!, before = await prisma.skillAvatarGenerationAttempt.count({ where: { releasedAt: null } })
    await avatars.uploadCustomAvatar({ ownerId, localSkillId: 'queued', image: { mimeType: 'image/png', dataBase64: bytes.toString('base64') } })
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { releasedAt: null } })).toBe(before - 1)
    expect((await prisma.skillAvatarGenerationAttempt.findUniqueOrThrow({ where: { jobId: id } })).releasedAt).not.toBeNull()
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatarId: id, jobId: null, releasedAt: null } })).toBe(1)
    await avatars.restoreGeneratedAvatar(ownerId, { localSkillId: 'queued' })
    const anchor = await prisma.skillAvatar.findUniqueOrThrow({ where: { id } })
    expect(anchor.currentJobId).not.toBe(id)
    expect((await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: anchor.currentJobId! } })).generationRevision).toBe(2)
    expect((await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id } })).status).toBe('cancelled')
    expect((await verifier.verifyAvatarModel()).counts.mismatches).toBe(0)
  }, 30_000)

  it('two callers with the same lease can consume the paid submit CAS only once', async () => {
    runBackfill()
    const row = await avatars.ensureSkillAvatar({ ownerId, localSkillId: 'submit-race', input })
    const leased = await prisma.$transaction(async tx => {
      const result = await tx.skillAvatar.update({ where: { id: row.id }, data: { leaseToken: 'shared-test-lease', leaseUntil: new Date(Date.now() + 60_000) } })
      await mirrorSkillAvatar(tx, row.id)
      return result
    })
    let arrivals = 0, release: () => void = () => undefined
    const bothDrafts = new Promise<void>(resolve => { release = resolve })
    draft.mockImplementation(async (): Promise<string> => {
      if (++arrivals === 2) release()
      await bothDrafts
      return 'A square illustration of a ribbon collecting leaves.\n\n' + SKILL_ART_FIXED_STYLE
    })
    await Promise.all([avatars.processAvatar(leased), avatars.processAvatar(leased)])
    expect(submit).toHaveBeenCalledTimes(1)
    expect((await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: leased.currentJobId! } })).status).toBe('awaiting')
    await expect(avatars.processAvatar(leased)).rejects.toThrow()
    expect(submit).toHaveBeenCalledTimes(1)
    expect((await verifier.verifyAvatarModel()).counts.mismatches).toBe(0)
  }, 30_000)

  it('preserves a superseded historical Job without changing its valid legacy anchor', async () => {
    runBackfill()
    // Only the new Job status constraint permits superseded; legacy anchors require an identity.
    const anchor = await prisma.skillAvatar.findUniqueOrThrow({ where: { id: ids.get('cancelled')! } })
    const current = await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id: anchor.currentJobId! } })
    const id = randomUUID()
    await prisma.avatarGenerationJob.create({ data: { ...current, id, generationRevision: 2,
      idempotencyKey: `avatar:${anchor.id}:2`, status: 'superseded', queuedAt: null } })
    expect(await prisma.skillAvatar.findUniqueOrThrow({ where: { id: anchor.id } })).toEqual(anchor)
    expect((await verifier.verifyAvatarModel()).counts.mismatches).toBe(0)
    expect((await prisma.avatarGenerationJob.findUniqueOrThrow({ where: { id } })).status).toBe('superseded')
  }, 30_000)

  it('old Prisma-shape writes still work and verifier catches their missing shadow state', async () => {
    runBackfill()
    const row = await prisma.skillAvatar.create({ data: { ownerId, localSkillId: 'old-client', input, inputFingerprint: 'fp', promptVersion: 'v1', status: 'failed' } })
    const result = await verifier.verifyAvatarModel()
    expect(result.counts['mismatch.jobCoverage']).toBe(1)
    await prisma.skillAvatar.update({ where: { id: row.id }, data: { errorCode: 'old-write' } })
    await prisma.skillAvatar.delete({ where: { id: row.id } })
    const id = ids.get('ready')!
    await prisma.$transaction(async tx => {
      await tx.skillAvatar.update({ where: { id }, data: { attempts: { increment: 1 } } })
    })
    expect((await verifier.verifyAvatarModel()).counts['mismatch.mirror']).toBeGreaterThan(0)
  }, 30_000)
})
