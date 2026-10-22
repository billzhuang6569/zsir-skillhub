import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #211 topic article contract (design §3.5 tables A / B / C) against a small stateful
 * fake of the topic, item, listing and audit tables. Transactions roll back on any
 * thrown error, so "data unchanged" is checked by comparing whole snapshots.
 */
type Topic = { id: string; slug: string; title: string; description: string | null; introContent: string | null; contentMarkdown: string | null
  coverImageUrl: string | null; status: string; featured: boolean; sortOrder: number; publishedAt: Date | null; createdAt: Date; updatedAt: Date }
type Item = { topicId: string; skillId: string; sortOrder: number }
const state = vi.hoisted(() => ({
  topics: new Map<string, unknown>(), items: [] as unknown[], audits: [] as unknown[],
  listings: new Map<string, { public: boolean; name: string }>(), auditFails: false,
}))
const fake = vi.hoisted(() => ({}) as Record<string, unknown>)
const clone = <T>(value: T): T => structuredClone(value)
const snapshot = (): string => JSON.stringify({ topics: [...state.topics.values()], items: state.items, audits: state.audits })
function listingRows(where: { skillId?: { in?: string[] }; withdrawnAt?: unknown }): string[] {
  return [...state.listings.entries()]
    .filter(([id, row]) => (!where.skillId?.in || where.skillId.in.includes(id)) && (!('withdrawnAt' in where) || row.public))
    .map(([id]) => id)
}
Object.assign(fake, {
  $queryRaw: async (strings: TemplateStringsArray): Promise<unknown[]> => strings.join('').includes('FROM users u') ? [{ id: 'admin-user' }] : [],
  $transaction: async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    const saved = { topics: clone(state.topics), items: clone(state.items), audits: clone(state.audits) }
    try { return await fn(fake) } catch (error: unknown) { Object.assign(state, saved); throw error }
  },
  marketplaceTopic: {
    findUnique: async (args: { where: { id: string } }): Promise<Topic | null> => clone((state.topics.get(args.where.id) as Topic | undefined) ?? null),
    create: async (args: { data: Partial<Topic> }): Promise<Topic> => {
      const now = new Date()
      const topic = { id: args.data.id ?? `topic-${state.topics.size + 1}`, description: null, introContent: null, contentMarkdown: null, coverImageUrl: null,
        status: 'draft', featured: false, sortOrder: 0, publishedAt: null, createdAt: now, updatedAt: now, ...args.data } as Topic
      state.topics.set(topic.id, topic)
      return clone(topic)
    },
    update: async (args: { where: { id: string }; data: Partial<Topic> }): Promise<Topic> => {
      const topic = state.topics.get(args.where.id) as Topic
      Object.assign(topic, args.data)
      return clone(topic)
    },
  },
  marketplaceTopicItem: {
    deleteMany: async (args: { where: { topicId: string } }): Promise<void> => { state.items = (state.items as Item[]).filter(item => item.topicId !== args.where.topicId) },
    createMany: async (args: { data: Item[] }): Promise<void> => { state.items.push(...args.data) },
  },
  marketplaceListing: {
    count: async (args: { where: { skillId?: { in?: string[] }; withdrawnAt?: unknown } }): Promise<number> => listingRows(args.where).length,
    findMany: async (args: { where: { skillId?: { in?: string[] }; withdrawnAt?: unknown } }): Promise<Array<{ skillId: string }>> => listingRows(args.where).map(skillId => ({ skillId })),
  },
  adminAgentAuditEvent: {
    create: async (args: { data: unknown }): Promise<void> => { if (state.auditFails) throw new Error('audit down'); state.audits.push(args.data) },
  },
})
vi.mock('../db.js', () => ({ db: fake }))
vi.mock('../lib/mutation-lock.js', () => ({ lockSkillMutation: vi.fn(), lockMarketplaceTopicMutation: vi.fn() }))
vi.mock('../middleware/auth.js', () => ({
  optionalAuthMiddleware: async (): Promise<void> => undefined,
  authMiddleware: async (request: FastifyRequest): Promise<void> => {
    request.user = { id: 'admin-user', email: 'admin@example.invalid', displayName: 'Admin', marketplaceRole: 'admin' }
  },
}))
import * as skillAnalysis from './skills.js'
import { marketplaceExperienceRoutes } from './marketplace-experience.js'

const PUBLIC = '7a2c5c1e-9d4e-4f0a-a4a0-0d2a5a4a9c11'
const PUBLIC_2 = '1b3d5f7a-2c4e-4b6d-8f0a-1c3e5a7b9d2f'
const HIDDEN = '9e8f7a6b-5c4d-4e3f-a2b1-0c9d8e7f6a5b'
const UNKNOWN = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
const LEGACY = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const ARTICLE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const ARTICLE_BODY = `## 收素材\n\n先说清楚目标。\n\n[pub](skill:${PUBLIC})`

let app: FastifyInstance
beforeEach(async () => {
  state.topics.clear(); state.items = []; state.audits = []; state.auditFails = false
  state.listings = new Map([[PUBLIC, { public: true, name: 'pub' }], [PUBLIC_2, { public: true, name: 'pub2' }], [HIDDEN, { public: false, name: 'hidden' }]])
  const base = { description: null, coverImageUrl: null, status: 'draft', featured: false, sortOrder: 0, publishedAt: null, createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z') }
  state.topics.set(LEGACY, { ...base, id: LEGACY, slug: 'legacy', title: '旧专题', introContent: '旧导语', contentMarkdown: null })
  state.topics.set(ARTICLE, { ...base, id: ARTICLE, slug: 'article', title: '文章专题', introContent: '收素材\n\n先说清楚目标。', contentMarkdown: ARTICLE_BODY })
  state.items = [{ topicId: LEGACY, skillId: PUBLIC, sortOrder: 0 }, { topicId: ARTICLE, skillId: PUBLIC, sortOrder: 0 }]
  app = Fastify()
  await app.register(sensible)
  await app.register(marketplaceExperienceRoutes, { prefix: '/api/marketplace' })
  await app.ready()
})
afterEach(async () => { await app.close(); vi.restoreAllMocks() })

const save = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/marketplace/admin/topics/save', payload })
const items = (topicId: string): string[] => (state.items as Item[]).filter(item => item.topicId === topicId).sort((a, b) => a.sortOrder - b.sortOrder).map(item => item.skillId)
const topic = (id: string): Topic => state.topics.get(id) as Topic
const STATES = [['un-articled', LEGACY], ['articled', ARTICLE]] as const

describe('table B: request shape × topic state', () => {
  it.each(STATES)('%s: a body without listingIds / introContent is checked and saved; the topic becomes an article', async (_name, id) => {
    const response = await save({ id, title: '新标题', status: 'draft', contentMarkdown: `导语段落\n\n[a](skill:${PUBLIC_2})\n\n[b](skill:${PUBLIC})` })
    expect(response.statusCode).toBe(200)
    expect(response.json().warnings).toEqual([])
    expect(topic(id)).toMatchObject({ title: '新标题', contentMarkdown: `导语段落\n\n[a](skill:${PUBLIC_2})\n\n[b](skill:${PUBLIC})`, introContent: '导语段落' })
    expect(items(id)).toEqual([PUBLIC_2, PUBLIC])
    expect(state.audits).toEqual([{ channel: 'web', actorAdminId: 'admin-user', operationId: 'marketplace.topic.save', outcome: `write:${id}` }])
  })
  it.each(STATES)('%s: a body together with listingIds or introContent is 400 TOPIC_DERIVED_FIELD and changes nothing', async (_name, id) => {
    const before = snapshot()
    for (const extra of [{ listingIds: [PUBLIC] }, { introContent: '手写导语' }, { introContent: null }]) {
      const response = await save({ id, title: 't', contentMarkdown: ARTICLE_BODY, ...extra })
      expect(response.statusCode).toBe(400)
      expect(response.json().code).toBe('TOPIC_DERIVED_FIELD')
    }
    expect(snapshot()).toBe(before)
  })
  it('legacy save: unchanged for an un-articled topic, 409 for an article', async () => {
    const legacy = await save({ id: LEGACY, title: '旧专题改', introContent: '新导语', listingIds: [PUBLIC_2], status: 'draft' })
    expect(legacy.statusCode).toBe(200)
    expect(legacy.json().warnings).toBeUndefined()
    expect(topic(LEGACY)).toMatchObject({ introContent: '新导语', contentMarkdown: null })
    expect(items(LEGACY)).toEqual([PUBLIC_2])
    const before = snapshot()
    const article = await save({ id: ARTICLE, title: '文章改', introContent: '想覆盖', listingIds: [PUBLIC_2], status: 'draft' })
    expect(article.statusCode).toBe(409)
    expect(article.json()).toEqual({ error: '这个专题已改为文章形态，请在新版后台编辑', code: 'TOPIC_ARTICLE_REQUIRES_UPGRADE' })
    expect(snapshot()).toBe(before)
  })
  it('PUT items: unchanged for an un-articled topic, 409 for an article', async () => {
    const legacy = await app.inject({ method: 'PUT', url: `/api/marketplace/admin/topics/${LEGACY}/items`, payload: { listingIds: [PUBLIC_2, PUBLIC] } })
    expect(legacy.statusCode).toBe(204)
    expect(items(LEGACY)).toEqual([PUBLIC_2, PUBLIC])
    const before = snapshot()
    const article = await app.inject({ method: 'PUT', url: `/api/marketplace/admin/topics/${ARTICLE}/items`, payload: { listingIds: [PUBLIC_2] } })
    expect(article.statusCode).toBe(409)
    expect(article.json().code).toBe('TOPIC_ARTICLE_REQUIRES_UPGRADE')
    expect(snapshot()).toBe(before)
  })
  it('PATCH meta fields: legacy unchanged; an article accepts them and re-checks its stored body when publishing', async () => {
    const meta = { title: '改名', description: '一句话', featured: true, sortOrder: 3 }
    for (const id of [LEGACY, ARTICLE]) {
      const response = await app.inject({ method: 'PATCH', url: `/api/marketplace/admin/topics/${id}`, payload: meta })
      expect(response.statusCode, id).toBe(200)
      expect(topic(id)).toMatchObject(meta)
    }
    const published = await app.inject({ method: 'PATCH', url: `/api/marketplace/admin/topics/${ARTICLE}`, payload: { status: 'published' } })
    expect(published.statusCode).toBe(200)
    expect(topic(ARTICLE).status).toBe('published')
    // The only embedded Skill was withdrawn meanwhile: publishing again is blocked, nothing changes.
    state.listings.set(PUBLIC, { public: false, name: 'pub' })
    topic(ARTICLE).status = 'draft'
    const before = snapshot()
    const blocked = await app.inject({ method: 'PATCH', url: `/api/marketplace/admin/topics/${ARTICLE}`, payload: { title: '再发', status: 'published' } })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json()).toMatchObject({ code: 'TOPIC_PUBLISH_BLOCKED', warnings: [
      { code: 'TOPIC_SKILL_UNAVAILABLE', line: 5, listingId: PUBLIC }, { code: 'TOPIC_NO_PUBLIC_SKILL', line: null },
    ] })
    expect(snapshot()).toBe(before)
  })
  it('PATCH introContent or slug: legacy unchanged; 409 for an article', async () => {
    const legacy = await app.inject({ method: 'PATCH', url: `/api/marketplace/admin/topics/${LEGACY}`, payload: { introContent: '改导语', slug: 'ignored-as-before' } })
    expect(legacy.statusCode).toBe(200)
    expect(topic(LEGACY)).toMatchObject({ introContent: '改导语', slug: 'legacy' })
    const before = snapshot()
    for (const payload of [{ introContent: '改导语' }, { slug: 'new-slug' }, { title: 'x', introContent: null }]) {
      const response = await app.inject({ method: 'PATCH', url: `/api/marketplace/admin/topics/${ARTICLE}`, payload })
      expect(response.statusCode).toBe(409)
      expect(response.json().code).toBe('TOPIC_ARTICLE_REQUIRES_UPGRADE')
    }
    expect(snapshot()).toBe(before)
  })
  it('a body is never silently dropped by PATCH or create', async () => {
    const before = snapshot()
    expect((await app.inject({ method: 'PATCH', url: `/api/marketplace/admin/topics/${LEGACY}`, payload: { contentMarkdown: ARTICLE_BODY } })).json().code).toBe('TOPIC_CONTENT_SAVE_ONLY')
    expect((await app.inject({ method: 'POST', url: '/api/marketplace/admin/topics', payload: { title: 'x', contentMarkdown: ARTICLE_BODY } })).json().code).toBe('TOPIC_CONTENT_SAVE_ONLY')
    expect(snapshot()).toBe(before)
  })
})

describe('table A: body checks × draft / published', () => {
  const errors: Array<[string, string, number]> = [
    ['TOPIC_CONTENT_TOO_LONG', `a\n${'x'.repeat(60_000)}`, 2],
    ['TOPIC_HTML_FORBIDDEN', 'ok\n\n<script>x</script>', 3],
    ['TOPIC_LINK_FORBIDDEN', 'ok\n[x](javascript:alert(1))', 2],
    ['TOPIC_SKILL_REF_INVALID', `[a](skill:${PUBLIC})\n\n[b](skill:12345)`, 3],
  ]
  for (const status of ['draft', 'published']) {
    it.each(errors)(`%s is a 400 with its line for a ${status} save and changes nothing`, async (code, body, line) => {
      const before = snapshot()
      const response = await save({ id: ARTICLE, title: 't', status, contentMarkdown: body })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ code, line })
      expect(snapshot()).toBe(before)
    })
  }
  const warnings: Array<[string, string, Record<string, unknown>]> = [
    ['TOPIC_SKILL_UNKNOWN', `[p](skill:${PUBLIC})\n\n[u](skill:${UNKNOWN})`, { code: 'TOPIC_SKILL_UNKNOWN', line: 3, listingId: UNKNOWN }],
    ['TOPIC_SKILL_UNAVAILABLE', `[p](skill:${PUBLIC})\n\n[h](skill:${HIDDEN})`, { code: 'TOPIC_SKILL_UNAVAILABLE', line: 3, listingId: HIDDEN }],
    ['TOPIC_IMAGE_HOST', `[p](skill:${PUBLIC})\n\n![x](https://evil.example/a.png)`, { code: 'TOPIC_IMAGE_HOST', line: 3 }],
    ['TOPIC_NO_PUBLIC_SKILL', '只有文字', { code: 'TOPIC_NO_PUBLIC_SKILL', line: null }],
  ]
  it.each(warnings)('%s: a draft saves with warnings', async (_code, body, warning) => {
    const response = await save({ id: ARTICLE, title: 't', status: 'draft', contentMarkdown: body })
    expect(response.statusCode).toBe(200)
    expect(response.json().warnings).toEqual([warning])
    expect(topic(ARTICLE).contentMarkdown).toBe(body)
  })
  it.each(warnings)('%s: publishing is a 409 with warnings and changes nothing', async (_code, body, warning) => {
    const before = snapshot()
    const response = await save({ id: ARTICLE, title: 't', status: 'published', contentMarkdown: body })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'TOPIC_PUBLISH_BLOCKED', warnings: [warning] })
    expect(snapshot()).toBe(before)
  })
})

describe('table C: derived items, intro and audit', () => {
  it('three embeds with one repeated → two items in first-occurrence order and a plain-text intro', async () => {
    const body = `# 标题\n\n第一段 **重点**。\n\n[a](skill:${PUBLIC_2})\n\n中间段。\n\n[b](skill:${PUBLIC}) [c](skill:${PUBLIC_2})`
    const response = await save({ title: '新建文章', status: 'published', contentMarkdown: body })
    expect(response.statusCode).toBe(200)
    const id = response.json().id as string
    expect(items(id)).toEqual([PUBLIC_2, PUBLIC])
    expect(topic(id).introContent).toBe('标题\n\n第一段 重点。\n\n中间段。')
    expect(topic(id).publishedAt).toBeInstanceOf(Date)
  })
  it('a draft that only references unknown Skills saves without items; unavailable Skills keep their row', async () => {
    const draft = await save({ id: LEGACY, title: 'd', status: 'draft', contentMarkdown: `[u](skill:${UNKNOWN})\n\n[h](skill:${HIDDEN})` })
    expect(draft.statusCode).toBe(200)
    expect(items(LEGACY)).toEqual([HIDDEN])
    expect(topic(LEGACY).contentMarkdown).toContain(UNKNOWN)
  })
  it('published with one public and one unknown Skill is a 409 and changes nothing', async () => {
    const before = snapshot()
    const response = await save({ id: LEGACY, title: 'p', status: 'published', contentMarkdown: `[p](skill:${PUBLIC})\n\n[u](skill:${UNKNOWN})` })
    expect(response.statusCode).toBe(409)
    expect(snapshot()).toBe(before)
  })
  it('a failed audit rolls back the whole save', async () => {
    state.auditFails = true
    const before = snapshot()
    const response = await save({ id: ARTICLE, title: 'x', status: 'draft', contentMarkdown: `[p](skill:${PUBLIC_2})` })
    expect(response.statusCode).toBe(503)
    expect(snapshot()).toBe(before)
  })
})

describe('AI article draft', () => {
  const listingRow = (skillId: string) => ({ skillId, submission: { skillName: 'tool', displayName: '工具', description: 'd', labels: [] } })
  const generate = async (contentMarkdown: string, ids = [PUBLIC]) => {
    ;(fake.marketplaceListing as Record<string, unknown>).findMany = async (): Promise<unknown[]> => ids.map(listingRow)
    vi.spyOn(skillAnalysis, 'requestConfiguredAiDraft').mockResolvedValue(JSON.stringify({ title: '专题', description: '一句话', contentMarkdown }))
    return app.inject({ method: 'POST', url: '/api/marketplace/admin/topics/generate', payload: { listingIds: ids } })
  }
  it('rejects out-of-set ids, missing embeds, outside images and HTML with 502 and writes nothing', async () => {
    const before = snapshot()
    for (const body of [
      `## a\n\n[x](skill:${PUBLIC})\n\n[y](skill:${UNKNOWN})`,
      '## a\n\n没有嵌入',
      `[x](skill:${PUBLIC})\n\n![i](https://evil.example/i.png)`,
      `[x](skill:${PUBLIC})\n\n<b>bold</b>`,
    ]) {
      const response = await generate(body)
      expect(response.statusCode, body).toBe(502)
      expect(response.json()).toEqual({ error: '生成结果不合规', code: 'TOPIC_AI_OUTPUT_INVALID' })
    }
    expect(snapshot()).toBe(before)
  })
  it('returns a valid article that embeds exactly the requested Skills', async () => {
    const response = await generate(`## 为什么\n\n介绍。\n\n[x](skill:${PUBLIC})\n\n[y](skill:${PUBLIC_2})`, [PUBLIC, PUBLIC_2])
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ title: '专题', listingIds: [PUBLIC, PUBLIC_2], introContent: '为什么\n\n介绍。' })
  })
})

/** PR #220 review (Codex P2): the reviewer's bodies through the real topics/save route. */
describe('review regressions through topics/save', () => {
  it.each([
    ['inline code beside a skill link', `\`说明\` [p](skill:${PUBLIC})`],
    ['list item continuation after a blank line', `- item\n\n  [p](skill:${PUBLIC})`],
  ])('%s is not an embed: publishing it is blocked with no public Skill and changes nothing', async (_name, body) => {
    const before = snapshot()
    const response = await save({ id: ARTICLE, title: 't', status: 'published', contentMarkdown: body })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'TOPIC_PUBLISH_BLOCKED', warnings: [{ code: 'TOPIC_NO_PUBLIC_SKILL', line: null }] })
    expect(snapshot()).toBe(before)
  })
  const images: Array<[string, string, number]> = [
    ['balanced brackets in alt', `[p](skill:${PUBLIC})\n\n![a [b]](https://outside.example/x.png)`, 3],
    ['reference-style image', `[p](skill:${PUBLIC})\n\n![a][ref]\n\n[ref]: https://outside.example/x.png`, 3],
  ]
  it.each(images)('%s outside the allowed hosts warns on a draft', async (_name, body, line) => {
    const response = await save({ id: ARTICLE, title: 't', status: 'draft', contentMarkdown: body })
    expect(response.statusCode).toBe(200)
    expect(response.json().warnings).toEqual([{ code: 'TOPIC_IMAGE_HOST', line }])
  })
  it.each(images)('%s outside the allowed hosts blocks publishing and changes nothing', async (_name, body, line) => {
    const before = snapshot()
    const response = await save({ id: ARTICLE, title: 't', status: 'published', contentMarkdown: body })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'TOPIC_PUBLISH_BLOCKED', warnings: [{ code: 'TOPIC_IMAGE_HOST', line }] })
    expect(snapshot()).toBe(before)
  })
  it('an out-of-range numeric entity saves as ordinary text instead of a 500', async () => {
    const body = `[p](skill:${PUBLIC})\n\n[x](https://example.test/&#99999999999999;)`
    const response = await save({ id: ARTICLE, title: 't', status: 'draft', contentMarkdown: body })
    expect(response.statusCode).toBe(200)
    expect(response.json().warnings).toEqual([])
    expect(topic(ARTICLE).contentMarkdown).toBe(body)
  })
})
