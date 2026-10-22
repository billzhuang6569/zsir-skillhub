import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SKILL_ART_FIXED_STYLE } from './skill-avatar-prompt.js'

const postgresUrl = process.env.SKILLHUB_PG_TEST_URL
const describePostgres = postgresUrl ? describe : describe.skip
describePostgres('Skill avatar PostgreSQL identity and restart recovery', () => {
  const ownerId = randomUUID(), otherId = randomUUID()
  let prisma: PrismaClient
  let avatars: typeof import('./skill-avatars.js')
  const submit = vi.fn(), draft = vi.fn(), upload = vi.fn()
  const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger
  const config = { SKILL_AVATARS_ENABLED: true, SKILL_MAX_PER_USER: 1, SKILL_AVATAR_DAILY_LIMIT: 200 }
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    vi.doMock('../config.js', () => ({ config }))
    vi.doMock('../routes/skills.js', () => ({ requestConfiguredAiDraft: draft }))
    vi.doMock('./fal.js', () => ({ submitFalAvatar: submit, pollFalAvatar: vi.fn(), downloadFalAvatar: vi.fn(), FalError: class extends Error {} }))
    vi.doMock('./media.js', () => ({ uploadMedia: upload, publicImageUrl: (url: string): string => url }))
    avatars = await import('./skill-avatars.js')
    await prisma.user.createMany({ data: [ownerId, otherId].map(id => ({ id, email: `avatar-qa-${id}@example.invalid`, displayName: 'Avatar QA' })) })
  })
  afterAll(async () => {
    if (!prisma) return
    await prisma.avatarSelection.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } })
    await prisma.skillAvatarGenerationAttempt.deleteMany({ where: { avatar: { ownerId: { in: [ownerId, otherId] } } } })
    await prisma.skillAvatar.updateMany({ where: { ownerId: { in: [ownerId, otherId] } }, data: { currentJobId: null } })
    await prisma.avatarVariant.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } })
    await prisma.avatarGenerationJob.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } })
    await prisma.skill.deleteMany({ where: { authorId: { in: [ownerId, otherId] } } })
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } })
    await prisma.$disconnect()
  })
  it('deduplicates concurrent local requests, isolates accounts and inherits on cloud binding', async () => {
    const options = { ownerId, localSkillId: 'stable-local-id', input: { name: 'Initial', description: 'Organize research', scenarios: [] } }
    const results = await Promise.all(Array.from({ length: 12 }, () => avatars.ensureSkillAvatar(options)))
    expect(new Set(results.map(task => task.id)).size).toBe(1)
    const first = results[0]
    const other = await avatars.ensureSkillAvatar({ ...options, ownerId: otherId })
    expect(other.id).not.toBe(first.id)
    const url = 'https://picem-media.whatonearth.work/qa-avatar.jpg'
    await prisma.skillAvatar.update({ where: { id: first.id }, data: { status: 'ready', assetId: 'ast_qa', url } })
    const skill = await prisma.skill.create({ data: { authorId: ownerId, name: 'uploaded', displayName: 'Uploaded' } })
    const beforePackages = await prisma.skillVersion.count({ where: { skillId: skill.id } })
    const bound = await avatars.ensureSkillAvatar({ ownerId, localSkillId: 'stable-local-id', skillId: skill.id })
    expect(bound.id).toBe(first.id)
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).avatarUrl).toBe(url)
    expect(await prisma.skillVersion.count({ where: { skillId: skill.id } })).toBe(beforePackages)
    await expect(avatars.ensureSkillAvatar({ ownerId: otherId, skillId: skill.id })).rejects.toMatchObject({ statusCode: 404 })
    const edited = await avatars.ensureSkillAvatar({ ...options, input: { name: 'Renamed', description: 'Edited', scenarios: [] } })
    expect(edited.input).toEqual(first.input)
    expect(edited.url).toBe(url)
    // Local inventory is independent of the cloud Skill count limit.
    const second = await avatars.ensureSkillAvatar({ ...options, localSkillId: 'second-local-id' })
    expect(second.id).not.toBe(first.id)
    await prisma.skillAvatar.update({ where: { id: second.id }, data: { status: 'failed' } })
    // This sibling account's queued job is unrelated to worker tests below.
    await prisma.skillAvatar.update({ where: { id: other.id }, data: { status: 'failed' } })
  })
  it('atomically grants one worker a lease and quarantines interrupted paid submission', async () => {
    const job = await avatars.ensureSkillAvatar({ ownerId, localSkillId: 'worker-test', input: { name: 'Flow', description: 'Filter useful sources', scenarios: [] } })
    const style = SKILL_ART_FIXED_STYLE
    draft.mockResolvedValue('A square illustration of a ribbon filtering leaves.\n\n' + style)
    submit.mockResolvedValue(randomUUID())
    await Promise.all([avatars.runAvatarWorkerOnce(logger), avatars.runAvatarWorkerOnce(logger)])
    expect(submit).toHaveBeenCalledTimes(1)
    const submitted = await prisma.skillAvatar.findUniqueOrThrow({ where: { id: job.id } })
    expect(submitted.status).toBe('awaiting')
    expect(submitted.requestId).toBeTruthy()
    // A distinct interrupted request has never persisted a provider requestId.
    const unknown = await prisma.skillAvatar.create({ data: {
      ownerId, localSkillId: 'interrupted-submit', input: submitted.input!, inputFingerprint: submitted.inputFingerprint,
      promptVersion: submitted.promptVersion, prompt: submitted.prompt, submittedAt: submitted.submittedAt,
      status: 'submitting', requestId: null, nextAttemptAt: new Date(0),
      leaseToken: 'dead-process', leaseUntil: new Date(0),
    } })
    await avatars.runAvatarWorkerOnce(logger)
    expect((await prisma.skillAvatar.findUniqueOrThrow({ where: { id: unknown.id } })).status).toBe('needs_review')
    expect(submit).toHaveBeenCalledTimes(1)
  })
  it('identity protocol on real constraints: concurrent devices share one task, old clients resolve aliases, accounts stay isolated', async () => {
    const input = { name: 'Identity', description: 'Alias protocol fixture', scenarios: [] }
    // Two devices register the same account entry at once, each with its own device id.
    const [a, b] = await Promise.all([
      avatars.ensureSkillAvatar({ ownerId, localSkillId: 'entry-pg', aliasLocalIds: ['device-a'], input }),
      avatars.ensureSkillAvatar({ ownerId, localSkillId: 'entry-pg', aliasLocalIds: ['device-b'], input }),
    ])
    expect(a.id).toBe(b.id)
    expect(await prisma.skillAvatar.count({ where: { ownerId, localSkillId: 'entry-pg' } })).toBe(1)
    const aliases = await prisma.skillAvatarAlias.findMany({ where: { ownerId, avatarId: a.id }, orderBy: { aliasLocalId: 'asc' } })
    expect(aliases.map(row => row.aliasLocalId)).toEqual(['device-a', 'device-b'])
    // An old client still sending only its device id reaches the same task; the canonical id is not renamed.
    const before = await prisma.skillAvatar.count({ where: { ownerId } })
    const old = await avatars.ensureSkillAvatar({ ownerId, localSkillId: 'device-a', input })
    expect(old.id).toBe(a.id)
    expect(old.localSkillId).toBe('entry-pg')
    expect(await prisma.skillAvatar.count({ where: { ownerId } })).toBe(before)
    // Another account's identical keys never resolve to this account's task.
    const foreign = await avatars.ensureSkillAvatar({ ownerId: otherId, localSkillId: 'device-a', input })
    expect(foreign.id).not.toBe(a.id)
    // An alias already owned by one task cannot be claimed for another: 409, nothing created.
    const countBefore = await prisma.skillAvatar.count({ where: { ownerId } })
    await expect(avatars.ensureSkillAvatar({ ownerId, localSkillId: 'entry-other', aliasLocalIds: ['device-a'], input }))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(await prisma.skillAvatar.count({ where: { ownerId } })).toBe(countBefore)
    await prisma.skillAvatar.updateMany({ where: { ownerId: { in: [ownerId, otherId] }, localSkillId: { in: ['entry-pg', 'device-a'] } }, data: { status: 'failed' } })
  })

  const png = (size: number): { mimeType: 'image/png'; dataBase64: string } => {
    const bytes = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
    bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(size, 16); bytes.writeUInt32BE(size, 20)
    return { mimeType: 'image/png', dataBase64: bytes.toString('base64') }
  }
  const customUrl = 'https://picem-media.whatonearth.work/pg-custom.png'

  it('custom upload: upload-only rows use no quota, and concurrent restores at the limit let only the first ones through', async () => {
    upload.mockResolvedValue({ assetId: 'ast_pg_custom', url: customUrl })
    const keys = Array.from({ length: 5 }, (_, index) => `custom-restore-${index}`)
    for (const key of keys) {
      const row = await avatars.uploadCustomAvatar({ ownerId, localSkillId: key, input: { name: 'Custom', description: 'Upload first', scenarios: [] }, image: png(512) })
      expect(row).toMatchObject({ status: 'cancelled', source: 'custom', queuedAt: null, customUrl })
    }
    // #221: today's usage is the attempt ledger, not skill_avatars.queuedAt.
    const day = avatars.utcDay(new Date())
    const queuedToday = await prisma.skillAvatarGenerationAttempt.count({ where: { day, releasedAt: null } })
    config.SKILL_AVATAR_DAILY_LIMIT = queuedToday + 2
    try {
      const results = await Promise.allSettled(keys.map(key => avatars.restoreGeneratedAvatar(ownerId, { localSkillId: key })))
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2)
      const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      expect(refused).toHaveLength(3)
      for (const result of refused) expect(result.reason).toMatchObject({ statusCode: 429, code: 'AVATAR_DAILY_QUOTA' })
      const rows = await prisma.skillAvatar.findMany({ where: { ownerId, localSkillId: { in: keys } } })
      expect(rows.filter(row => row.status === 'queued' && row.source === 'generated')).toHaveLength(2)
      expect(rows.filter(row => row.status === 'cancelled' && row.source === 'custom' && row.customUrl === customUrl && row.queuedAt === null)).toHaveLength(3)
      expect(await prisma.skillAvatarGenerationAttempt.count({ where: { day, releasedAt: null } })).toBe(queuedToday + 2)
    } finally {
      config.SKILL_AVATAR_DAILY_LIMIT = 200
      await prisma.skillAvatar.updateMany({ where: { ownerId, localSkillId: { in: keys } }, data: { status: 'failed', source: 'generated', customUrl: null, customAssetId: null } })
    }
  })

  it('custom upload keeps Skill.avatarUrl on the custom image while the worker finishes, and restore shows the generated one', async () => {
    upload.mockResolvedValue({ assetId: 'ast_pg_custom', url: customUrl })
    const skill = await prisma.skill.create({ data: { authorId: ownerId, name: 'custom-cloud', displayName: 'Custom cloud', description: 'Cloud skill' } })
    const task = await avatars.ensureSkillAvatar({ ownerId, skillId: skill.id })
    expect(task.queuedAt).toBeInstanceOf(Date)
    // The worker has claimed the task and is transferring the paid image.
    await prisma.skillAvatar.update({ where: { id: task.id }, data: { status: 'transferring', leaseToken: 'pg-worker', imageData: Buffer.from('jpeg'), requestId: randomUUID() } })
    await avatars.uploadCustomAvatar({ ownerId, skillId: skill.id, image: png(1024) })
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).toMatchObject({ avatarUrl: customUrl, avatarStatus: 'ready' })
    const generatedUrl = 'https://picem-media.whatonearth.work/pg-generated.jpg'
    upload.mockResolvedValue({ assetId: 'ast_pg_generated', url: generatedUrl })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { headers: { 'content-type': 'image/jpeg' } })))
    try {
      await avatars.processAvatar({ ...await prisma.skillAvatar.findUniqueOrThrow({ where: { id: task.id } }) })
    } finally { vi.unstubAllGlobals() }
    expect(await prisma.skillAvatar.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'ready', url: generatedUrl, source: 'custom', leaseToken: 'pg-worker' })
    // Store listings, team shares and account sync all read Skill.avatarUrl.
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).toMatchObject({ avatarUrl: customUrl, avatarStatus: 'ready' })
    await expect(avatars.restoreGeneratedAvatar(otherId, { skillId: skill.id })).rejects.toMatchObject({ statusCode: 404 })
    const restored = await avatars.restoreGeneratedAvatar(ownerId, { skillId: skill.id })
    expect(avatars.avatarDto(restored)).toEqual({ avatarUrl: generatedUrl, avatarStatus: 'ready', avatarSource: 'generated' })
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).toMatchObject({ avatarUrl: generatedUrl, avatarStatus: 'ready' })
    // A custom row without its image is refused by the database itself.
    await expect(prisma.skillAvatar.update({ where: { id: task.id }, data: { source: 'custom' } })).rejects.toThrow()
  })

  it('lists the owner\'s cloud-only tasks with their source, so a new session or device can offer restore', async () => {
    upload.mockResolvedValue({ assetId: 'ast_pg_custom', url: customUrl })
    vi.doMock('../middleware/auth.js', () => ({ authMiddleware: async (request: { headers: Record<string, unknown>; user: unknown }): Promise<void> => {
      const id = String(request.headers['x-test-user'])
      request.user = { id, email: `${id}@example.invalid`, displayName: 'QA', marketplaceRole: 'user' }
    } }))
    const [{ default: Fastify }, { default: sensible }, { skillAvatarRoutes }] = await Promise.all([import('fastify'), import('@fastify/sensible'), import('../routes/skill-avatars.js')])
    const app = Fastify()
    await app.register(sensible)
    await app.register(skillAvatarRoutes, { prefix: '/api/skill-avatars' })
    await app.ready()
    try {
      const skill = await prisma.skill.create({ data: { authorId: ownerId, name: 'cloud-only-custom', displayName: 'Cloud only', description: 'Cloud only skill' } })
      const task = await avatars.ensureSkillAvatar({ ownerId, skillId: skill.id })
      expect(task.localSkillId).toBeNull()
      await avatars.uploadCustomAvatar({ ownerId, skillId: skill.id, image: png(512) })
      const list = async (userId: string) => (await app.inject({ url: '/api/skill-avatars/local', headers: { 'x-test-user': userId } })).json().items as Array<Record<string, unknown>>
      // Any session or device of the owner reads the authoritative source from the list; no ensure is needed.
      expect((await list(ownerId)).find(item => item.skillId === skill.id)).toEqual({
        localSkillId: null, skillId: skill.id, aliases: [], avatarUrl: customUrl, avatarStatus: 'ready', avatarSource: 'custom',
      })
      expect((await list(otherId)).find(item => item.skillId === skill.id)).toBeUndefined()
      // A deleted cloud Skill's task is no longer listed.
      await prisma.skill.update({ where: { id: skill.id }, data: { deletedAt: new Date() } })
      expect((await list(ownerId)).find(item => item.skillId === skill.id)).toBeUndefined()
    } finally {
      await app.close()
      vi.doUnmock('../middleware/auth.js')
    }
  })
})
