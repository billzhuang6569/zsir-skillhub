import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const postgresUrl = process.env.SKILLHUB_PG_TEST_URL
const suite = postgresUrl ? describe : describe.skip

suite('source avatar export (PostgreSQL)', () => {
  const owners = [randomUUID(), randomUUID()]
  const styleIds = [randomUUID(), randomUUID()]
  let acting = owners[0]
  let prisma: PrismaClient, app: FastifyInstance
  let config: typeof import('../config.js')['config']
  let oldMode: typeof config.SKILL_AVATAR_MODEL_READS
  let oldProfile: typeof config.SKILLHUB_PROFILE
  let display: typeof import('../lib/avatar-selection.js')
  const anchors: Array<{ id: string; skillId: string; localSkillId: string; variants: string[] }> = []
  const date = new Date('2026-10-20T00:00:00Z')

  beforeAll(async (): Promise<void> => {
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    vi.doMock('../middleware/auth.js', () => ({
      authMiddleware: async (request: FastifyRequest): Promise<void> => {
        request.user = { id: acting, email: `${acting}@example.invalid`, displayName: 'Export QA', marketplaceRole: 'user' }
      },
    }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network forbidden in export tests')))
    config = (await import('../config.js')).config
    oldMode = config.SKILL_AVATAR_MODEL_READS
    oldProfile = config.SKILLHUB_PROFILE
    config.SKILL_AVATAR_MODEL_READS = 'variants'
    display = await import('../lib/avatar-selection.js')
    await prisma.user.createMany({ data: owners.map(id => ({ id, email: `${id}@example.invalid`, displayName: 'Export QA' })) })
    for (const [styleId, styleVersion] of [[styleIds[0], 1], [styleIds[0], 2], [styleIds[1], 1]] as const) {
      await prisma.avatarStyleVersion.create({ data: { styleId, styleVersion, content: '{}', contentSha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', source: 'repository' } })
    }
    for (const ownerId of owners) {
      const skill = await prisma.skill.create({ data: { authorId: ownerId, name: `export-${ownerId}`, displayName: 'Export QA' } })
      const anchor = await prisma.skillAvatar.create({ data: { ownerId, skillId: skill.id, localSkillId: randomUUID(),
        input: {}, inputFingerprint: 'fixture', promptVersion: 'fixture', status: 'failed' } })
      const variants: string[] = []
      for (let index = 0; index < 3; index++) {
        const styleId = index < 2 ? styleIds[0] : styleIds[1]
        const styleVersion = index === 1 ? 2 : 1
        const job = await prisma.avatarGenerationJob.create({ data: {
          ownerId, logicalSkillId: anchor.id, generationRevision: index + 1, selectionRevision: 1,
          styleId, styleVersion, input: {}, inputFingerprint: 'fixture', promptVersion: 'fixture',
          falModel: 'fixture', falParameters: {}, idempotencyKey: randomUUID(), status: 'ready',
          prompt: 'private prompt', requestId: randomUUID(),
        } })
        const variant = await prisma.avatarVariant.create({ data: {
          ownerId, logicalSkillId: anchor.id, generationRevision: index + 1, styleId, styleVersion,
          inputFingerprint: 'fixture', promptVersion: 'fixture', path: 'meta', jobId: job.id,
          url: `/media/${job.id}.png`, imageSha256: index === 0 ? null : 'b'.repeat(64), createdAt: date,
          prompt: 'private prompt',
        } })
        variants.push(variant.id)
      }
      await prisma.avatarSelection.create({ data: { ownerId, logicalSkillId: anchor.id, variantId: variants[0],
        customUrl: '/media/custom.png', customUpdatedAt: date } })
      anchors.push({ id: anchor.id, skillId: skill.id, localSkillId: anchor.localSkillId!, variants })
    }
    app = Fastify()
    await app.register(sensible)
    await app.register((await import('./skill-avatars.js')).skillAvatarRoutes, { prefix: '/api/skill-avatars' })
    await app.ready()
  })

  afterAll(async (): Promise<void> => {
    await app?.close()
    if (prisma) {
      const mine = { ownerId: { in: owners } }
      await prisma.avatarSelection.deleteMany({ where: mine })
      await prisma.avatarVariant.deleteMany({ where: mine })
      await prisma.avatarGenerationJob.deleteMany({ where: mine })
      await prisma.skillAvatar.deleteMany({ where: mine })
      await prisma.skill.deleteMany({ where: { authorId: { in: owners } } })
      await prisma.user.deleteMany({ where: { id: { in: owners } } })
      // Immutable style fixtures remain in the disposable test DB, isolated by UUID.
      await prisma.$disconnect()
    }
    if (config) { config.SKILL_AVATAR_MODEL_READS = oldMode; config.SKILLHUB_PROFILE = oldProfile }
    vi.unstubAllGlobals()
  })

  it.each(['selfhost', 'yitan-official'] as const)('exports full history and the actual display in %s', async profile => {
    config.SKILLHUB_PROFILE = profile
    acting = owners[0]
    const anchor = anchors[0]
    for (const source of ['generated', 'custom']) {
      await prisma.avatarSelection.update({ where: { ownerId_logicalSkillId: { ownerId: acting, logicalSkillId: anchor.id } }, data: { source } })
      const response = await app.inject(`/api/skill-avatars/export?skillIds=${anchor.skillId}`)
      expect(response.statusCode, response.body).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store, private')
      const item = response.json().items[0]
      expect(item.variants.map((variant: { variantId: string }) => variant.variantId)).toEqual([...anchor.variants].reverse())
      expect(item.variants.map((variant: { styleId: string; styleVersion: number }) => [variant.styleId, variant.styleVersion]))
        .toEqual([[styleIds[1], 1], [styleIds[0], 2], [styleIds[0], 1]])
      expect(item.selected).toEqual(source === 'custom' ? { kind: 'custom' } : { kind: 'generated', variantId: anchor.variants[0] })
      const projected = display.selectionAvatar(await display.readOwnerSelection(prisma, anchor.skillId))
      const selectedUrl = source === 'custom' ? item.custom.url
        : item.variants.find((variant: { variantId: string }) => variant.variantId === item.selected.variantId).url
      expect(selectedUrl).toBe(projected.avatarUrl)
      expect(item.variants[2].sha256).toBeNull()
      expect(response.body).not.toMatch(/prompt|requestId|falModel/)
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(await prisma.skillAvatarGenerationAttempt.count({ where: { avatar: { ownerId: acting } } })).toBe(0)
  })

  it('silently omits foreign and nonexistent cloud/local anchors in mixed batches', async (): Promise<void> => {
    for (let index = 0; index < owners.length; index++) {
      acting = owners[index]
      for (const key of ['skillId', 'localSkillId'] as const) {
        const query = key === 'skillId' ? 'skillIds' : 'localSkillIds'
        const response = await app.inject(`/api/skill-avatars/export?${query}=${anchors.map(anchor => anchor[key]).join(',')},${randomUUID()}`)
        expect(response.statusCode).toBe(200)
        expect(response.json().items.map((item: { anchorId: string }) => item.anchorId)).toEqual([anchors[index].id])
        const foreign = await app.inject(`/api/skill-avatars/export?${query}=${anchors[1 - index][key]}`)
        expect(foreign.json()).toEqual({ items: [] })
      }
    }
  })
})
