import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const postgresUrl = process.env['SKILLHUB_PG_TEST_URL']
const OWNER = 'c3c3c3c3-0000-4000-8000-000000000001'
const OTHER = 'c3c3c3c3-0000-4000-8000-000000000002'
const USERS = [OWNER, OTHER]
const CARD = 'c'.repeat(64)
const mockConfig = vi.hoisted(() => ({
  AI_API_BASE_URL: undefined,
  AI_API_KEY: undefined,
  AI_MODEL: 'test-model',
  AI_PROTOCOL: 'openai',
  AI_RATE_LIMIT_PER_MINUTE: 100,
  AI_GLOBAL_DAILY_LIMIT: 1000,
  AI_MAX_CONCURRENT: 2,
  AI_TIMEOUT_MS: 30_000,
  SKILL_MAX_PER_USER: 50,
  SKILL_MAX_VERSIONS_PER_SKILL: 30,
  SKILL_MAX_STORAGE_BYTES_PER_USER: 250 * 1024 * 1024,
  SKILL_VERSION_WRITES_PER_HOUR: 30,
  SKILL_CARD_STORAGE_DIR: '',
  LIBRARY_CARD_UPLOADS_PER_HOUR: 10_000,
  LIBRARY_CARD_DOWNLOADS_PER_MINUTE: 10_000,
  SKILL_AVATARS_ENABLED: false,
}))

describe.skipIf(!postgresUrl)('PostgreSQL library tags and quick access', () => {
  let prisma: PrismaClient
  let app: FastifyInstance

  async function entry(userId: string, name: string): Promise<string> {
    const id = randomUUID()
    await prisma.libraryEntry.create({ data: { id, userId, name, cardSha256: CARD, requestDigest: 'fixture' } })
    return id
  }

  async function call(method: 'GET' | 'PUT' | 'POST' | 'PATCH', url: string, payload?: unknown, user = OWNER): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await app.inject({ method, url, payload: payload as Record<string, unknown> | undefined, headers: { 'x-test-user': user } })
    return { status: response.statusCode, body: response.json() as Record<string, unknown> }
  }

  beforeAll(async () => {
    if (!postgresUrl) return
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    vi.doMock('../config.js', () => ({ config: mockConfig }))
    vi.doMock('../middleware/auth.js', () => ({
      authMiddleware: async (request: FastifyRequest): Promise<void> => {
        const id = String(request.headers['x-test-user'] ?? OWNER)
        request.user = { id, email: `${id}@example.com`, displayName: id }
      },
    }))
    const { libraryOrganizerRoutes } = await import('./library-organizer.js')
    app = Fastify()
    await app.register(sensible)
    await app.register(libraryOrganizerRoutes, { prefix: '/api' })
    await app.ready()
  })

  beforeEach(async () => {
    await prisma.libraryQuickAccess.deleteMany({ where: { userId: { in: USERS } } })
    await prisma.librarySkillTag.deleteMany({ where: { userId: { in: USERS } } })
    await prisma.libraryEntry.deleteMany({ where: { userId: { in: USERS } } })
    for (const id of USERS) {
      await prisma.user.upsert({ where: { id }, create: { id, email: `${id}@example.com`, displayName: id }, update: {} })
    }
    await prisma.skillCard.upsert({ where: { sha256: CARD }, create: { sha256: CARD, contentHash: 'fixture', size: 1, storageKey: 'fixture' }, update: {} })
  })

  afterAll(async () => {
    if (!postgresUrl) return
    await prisma.libraryQuickAccess.deleteMany({ where: { userId: { in: USERS } } })
    await prisma.librarySkillTag.deleteMany({ where: { userId: { in: USERS } } })
    await prisma.libraryEntry.deleteMany({ where: { userId: { in: USERS } } })
    await prisma.user.deleteMany({ where: { id: { in: USERS } } })
    await app.close()
    await prisma.$disconnect()
  })

  it('stores per-Skill tags privately with case-insensitive dedupe and shared casing', async () => {
    const first = await entry(OWNER, 'writer')
    const second = await entry(OWNER, 'coder')

    expect(await call('PUT', `/api/library/tags/${first}`, { names: ['Writing', ' writing ', '办公'] }))
      .toEqual({ status: 200, body: { entryId: first, names: ['Writing', '办公'] } })
    expect((await call('PUT', `/api/library/tags/${second}`, { names: ['WRITING'] })).body)
      .toEqual({ entryId: second, names: ['Writing'] })

    const listed = await call('GET', '/api/library/tags')
    expect(listed.body['tags']).toEqual([
      { entryId: first, names: ['Writing', '办公'] },
      { entryId: second, names: ['Writing'] },
    ])
    expect((await call('GET', '/api/library/tags', undefined, OTHER)).body).toEqual({ tags: [] })

    expect((await call('PUT', `/api/library/tags/${first}`, { names: [] })).body).toEqual({ entryId: first, names: [] })
  })

  it('enforces ownership, live entries and the per-Skill limit', async () => {
    const mine = await entry(OWNER, 'mine')
    const theirs = await entry(OTHER, 'theirs')
    expect((await call('PUT', `/api/library/tags/${theirs}`, { names: ['x'] })).status).toBe(404)
    expect((await call('PUT', `/api/library/tags/${mine}`, { names: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] })).status).toBe(400)
    expect((await call('PUT', `/api/library/tags/${mine}`, { names: ['x'.repeat(33)] })).status).toBe(400)
    await prisma.libraryEntry.update({ where: { id: mine }, data: { deletedAt: new Date() } })
    expect((await call('PUT', `/api/library/tags/${mine}`, { names: ['x'] })).status).toBe(404)
  })

  it('hides tags of deleted entries and restores them with the entry', async () => {
    const id = await entry(OWNER, 'restorable')
    await call('PUT', `/api/library/tags/${id}`, { names: ['Keep'] })
    await prisma.libraryEntry.update({ where: { id }, data: { deletedAt: new Date() } })
    expect((await call('GET', '/api/library/tags')).body).toEqual({ tags: [] })
    await prisma.libraryEntry.update({ where: { id }, data: { deletedAt: null } })
    expect((await call('GET', '/api/library/tags')).body).toEqual({ tags: [{ entryId: id, names: ['Keep'] }] })
  })

  it('replaces quick access under CAS and reports the current list on conflict', async () => {
    const skill = await entry(OWNER, 'pinned')
    await call('PUT', `/api/library/tags/${skill}`, { names: ['Writing'] })
    expect((await call('GET', '/api/library/quick-access')).body).toEqual({ revision: 0, items: [] })

    const saved = await call('PUT', '/api/library/quick-access', { baseRevision: 0, items: [{ kind: 'tag', ref: 'writing' }, { kind: 'skill', ref: skill }, { kind: 'skill', ref: 'missing' }] })
    expect(saved).toEqual({ status: 200, body: { revision: 1, items: [{ kind: 'tag', ref: 'Writing' }, { kind: 'skill', ref: skill }] } })

    const stale = await call('PUT', '/api/library/quick-access', { baseRevision: 0, items: [] })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ code: 'QUICK_ACCESS_CONFLICT', current: { revision: 1, items: [{ kind: 'tag', ref: 'Writing' }, { kind: 'skill', ref: skill }] } })

    const [left, right] = await Promise.all([
      call('PUT', '/api/library/quick-access', { baseRevision: 1, items: [{ kind: 'skill', ref: skill }] }),
      call('PUT', '/api/library/quick-access', { baseRevision: 1, items: [] }),
    ])
    expect([left.status, right.status].sort()).toEqual([200, 409])
    expect((await call('GET', '/api/library/quick-access', undefined, OTHER)).body).toEqual({ revision: 0, items: [] })
  })

  it('removes quick-access items when the Skill is deleted or the tag is emptied', async () => {
    const skill = await entry(OWNER, 'temporary')
    await call('PUT', `/api/library/tags/${skill}`, { names: ['Solo'] })
    await call('PUT', '/api/library/quick-access', { baseRevision: 0, items: [{ kind: 'tag', ref: 'Solo' }, { kind: 'skill', ref: skill }] })
    await call('PUT', `/api/library/tags/${skill}`, { names: [] })
    expect((await call('GET', '/api/library/quick-access')).body).toEqual({ revision: 2, items: [{ kind: 'skill', ref: skill }] })
    await prisma.libraryEntry.update({ where: { id: skill }, data: { deletedAt: new Date() } })
    expect((await call('GET', '/api/library/quick-access')).body).toEqual({ revision: 2, items: [] })
  })

  it('does not resurrect an emptied tag pin and ignores deleted entries for casing', async () => {
    const live = await entry(OWNER, 'live')
    const gone = await entry(OWNER, 'gone')
    await call('PUT', `/api/library/tags/${gone}`, { names: ['Ghost'] })
    await prisma.libraryEntry.update({ where: { id: gone }, data: { deletedAt: new Date() } })
    expect((await call('PUT', `/api/library/tags/${live}`, { names: ['GHOST'] })).body).toEqual({ entryId: live, names: ['GHOST'] })

    await call('PUT', `/api/library/tags/${live}`, { names: ['work'] })
    await call('PUT', '/api/library/quick-access', { baseRevision: 0, items: [{ kind: 'tag', ref: 'work' }] })
    await call('PUT', `/api/library/tags/${live}`, { names: [] })
    await call('PUT', `/api/library/tags/${live}`, { names: ['Work'] })
    expect((await call('GET', '/api/library/quick-access')).body).toEqual({ revision: 2, items: [] })
  })

  it('deleting a library entry removes its pins for good, even if quick access was never read', async () => {
    const { libraryRoutes } = await import('./library.js')
    const full = Fastify()
    await full.register(sensible)
    await full.register(libraryRoutes, { prefix: '/api' })
    await full.register((await import('./library-organizer.js')).libraryOrganizerRoutes, { prefix: '/api' })
    await full.ready()
    try {
      const skill = await entry(OWNER, 'pinned-then-deleted')
      const other = await entry(OWNER, 'keeps-shared-tag')
      await call('PUT', `/api/library/tags/${skill}`, { names: ['Only', 'Shared'] })
      await call('PUT', `/api/library/tags/${other}`, { names: ['Shared'] })
      await call('PUT', '/api/library/quick-access', { baseRevision: 0, items: [{ kind: 'skill', ref: skill }, { kind: 'tag', ref: 'Only' }, { kind: 'tag', ref: 'Shared' }] })
      const revision = (await prisma.libraryEntry.findUniqueOrThrow({ where: { id: skill } })).revision
      const removed = await full.inject({ method: 'DELETE', url: `/api/library/${skill}?baseRevision=${revision}`, headers: { 'x-test-user': OWNER } })
      expect(removed.statusCode).toBe(200)
      const restored = await full.inject({ method: 'POST', url: `/api/library/${skill}/restore`, payload: { baseRevision: revision + 1 }, headers: { 'x-test-user': OWNER } })
      expect(restored.statusCode).toBe(200)
      expect((await call('GET', '/api/library/quick-access')).body).toEqual({ revision: 2, items: [{ kind: 'tag', ref: 'Shared' }] })
      expect((await call('GET', '/api/library/tags')).body['tags']).toEqual(expect.arrayContaining([{ entryId: skill, names: ['Only', 'Shared'] }]))
    } finally {
      await full.close()
    }
  })

  it('renames, merges and deletes tags across Skills and quick access', async () => {
    const a = await entry(OWNER, 'a')
    const b = await entry(OWNER, 'b')
    await call('PUT', `/api/library/tags/${a}`, { names: ['Draft', 'Final'] })
    await call('PUT', `/api/library/tags/${b}`, { names: ['Draft'] })
    await call('PUT', '/api/library/quick-access', { baseRevision: 0, items: [{ kind: 'tag', ref: 'Draft' }] })

    const merged = await call('POST', '/api/library/tags/rename', { from: 'draft', to: 'final' })
    expect(merged.status).toBe(200)
    expect(merged.body['tags']).toEqual([{ entryId: a, names: ['Final'] }, { entryId: b, names: ['Final'] }])
    expect(merged.body['quickAccess']).toEqual({ revision: 2, items: [{ kind: 'tag', ref: 'Final' }] })

    const recased = await call('POST', '/api/library/tags/rename', { from: 'final', to: 'FINAL' })
    expect(recased.body['tags']).toEqual([{ entryId: a, names: ['FINAL'] }, { entryId: b, names: ['FINAL'] }])
    expect((await call('POST', '/api/library/tags/rename', { from: 'nope', to: 'x' })).status).toBe(404)

    const deleted = await call('POST', '/api/library/tags/delete', { name: 'final' })
    expect(deleted.body).toEqual({ tags: [], quickAccess: { revision: 4, items: [] } })
    expect(await prisma.libraryEntry.count({ where: { id: { in: [a, b] } } })).toBe(2)
  })

  it('applies tag deltas atomically so concurrent additions and removals all survive (#326)', async () => {
    const id = await entry(OWNER, 'shared')
    const other = await entry(OWNER, 'other')
    await call('PUT', `/api/library/tags/${other}`, { names: ['Daily'] })
    await call('PUT', `/api/library/tags/${id}`, { names: ['Base', 'Gone'] })

    const [left, right] = await Promise.all([
      call('PATCH', `/api/library/tags/${id}`, { add: ['Added-A'], remove: [] }),
      call('PATCH', `/api/library/tags/${id}`, { add: ['Added-B', 'daily'], remove: ['gone'] }),
    ])
    expect([left.status, right.status]).toEqual([200, 200])
    const final = await call('GET', '/api/library/tags')
    const names = (final.body['tags'] as Array<{ entryId: string; names: string[] }>).find((set) => set.entryId === id)?.names
    expect(names?.slice().sort()).toEqual(['Added-A', 'Added-B', 'Base', 'Daily'])

    // A removal is not undone by another device adding something else.
    expect((await call('PATCH', `/api/library/tags/${id}`, { remove: ['BASE'] })).body).toMatchObject({ entryId: id })
    expect(((await call('PATCH', `/api/library/tags/${id}`, { add: ['Y'] })).body['names'] as string[]).includes('Base')).toBe(false)
  })

  it('rejects deltas beyond the per-Skill limit and for entries that are not live and owned', async () => {
    const id = await entry(OWNER, 'full')
    await call('PUT', `/api/library/tags/${id}`, { names: ['1', '2', '3', '4', '5', '6', '7'] })
    const limited = await call('PATCH', `/api/library/tags/${id}`, { add: ['8', '9'] })
    expect(limited).toMatchObject({ status: 400, body: { code: 'TAG_LIMIT' } })
    expect((await call('PATCH', `/api/library/tags/${id}`, { add: ['8', '9'], remove: ['1'] })).body['names']).toHaveLength(8)
    const theirs = await entry(OTHER, 'theirs')
    expect((await call('PATCH', `/api/library/tags/${theirs}`, { add: ['x'] })).status).toBe(404)
    await prisma.libraryEntry.update({ where: { id }, data: { deletedAt: new Date() } })
    expect((await call('PATCH', `/api/library/tags/${id}`, { add: ['x'] })).status).toBe(404)
    expect((await call('PATCH', `/api/library/tags/${id}`, { add: [], nope: 1 })).status).toBe(400)
  })
})
