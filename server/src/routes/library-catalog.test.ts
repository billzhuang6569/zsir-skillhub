import Fastify, { type FastifyInstance, type FastifyRequest, type LightMyRequestResponse } from 'fastify'
import sensible from '@fastify/sensible'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  profile: 'selfhost', findEntry: vi.fn(), firstEntry: vi.fn(), createEntry: vi.fn(), updateEntry: vi.fn(), readEntry: vi.fn(),
  grant: vi.fn(), card: vi.fn(), raw: vi.fn(), fetch: vi.fn(), lock: vi.fn(), count: vi.fn(),
}))
vi.mock('../config.js', async () => {
  const { configSchema } = await import('../config-schema.js')
  return { config: { ...configSchema.parse(process.env), CATALOG_ORIGIN: 'https://catalog.example.test/skillhub',
    get SKILLHUB_PROFILE(): string { return mock.profile } } }
})
vi.mock('../db.js', () => {
  const tx = {
    libraryEntry: { findUnique: mock.findEntry, findFirst: mock.firstEntry, findUniqueOrThrow: mock.readEntry,
      create: mock.createEntry, update: mock.updateEntry, count: mock.count },
    cardGrant: { findUnique: mock.grant }, skillCard: { findUnique: mock.card },
    skill: { findMany: async (): Promise<unknown[]> => [] },
    libraryEntryVersion: { findMany: async (): Promise<unknown[]> => [] },
    $executeRaw: mock.raw,
  }
  return { db: { ...tx, $transaction: (fn: (transaction: typeof tx) => Promise<unknown>): Promise<unknown> => fn(tx) } }
})
vi.mock('../lib/mutation-lock.js', () => ({ lockUserMutation: mock.lock, lockSkillMutation: mock.lock, lockSkillTeamMutation: mock.lock }))
vi.mock('../middleware/auth.js', () => ({ authMiddleware: async (request: FastifyRequest): Promise<void> => {
  request.user = { id: 'owner', email: '', displayName: '', marketplaceRole: 'user' }
} }))
import { libraryRoutes } from './library.js'

const source = { kind: 'catalog', skillId: 'a1a1a1a1-0000-4000-8000-000000000001', version: '0.1.0', packageSha256: 'a'.repeat(64) }
const id = 'b1b1b1b1-0000-4000-8000-000000000001'
const card = { sha256: source.packageSha256, contentHash: 'b'.repeat(64), executablePaths: [], size: 123, createdById: 'another-user' }
const entry = { id, userId: 'owner', name: 'catalog-skill', profile: { displayName: 'Catalog Skill', sourceUrl: null },
  cardSha256: card.sha256, card, sourceKind: 'catalog', sourceOrigin: 'https://catalog.example.test/skillhub',
  sourceSkillId: source.skillId, sourceVersionId: source.version, authorSkillId: null, migrationKey: null,
  currentVersionReceiptId: null, versionHighWater: -1, revision: 1, deletedAt: null, requestDigest: 'test' }
const payload = { id, name: entry.name, profile: entry.profile, source }
const metadata = { id: source.skillId, version: { version: source.version, packageSha256: source.packageSha256 } }
let app: FastifyInstance
const create = (body: object = payload): Promise<LightMyRequestResponse> => app.inject({ method: 'POST', url: '/api/library', payload: body })
const update = (body: object): Promise<LightMyRequestResponse> => app.inject({ method: 'PUT', url: `/api/library/${id}`, payload: body })

beforeEach(async (): Promise<void> => {
  vi.resetAllMocks(); mock.profile = 'selfhost'
  mock.fetch.mockImplementation(async (): Promise<Response> => Response.json(metadata)); vi.stubGlobal('fetch', mock.fetch)
  mock.grant.mockResolvedValue({ reason: 'upload', card: { sha256: card.sha256 } })
  mock.card.mockResolvedValue(card); mock.count.mockResolvedValue(0)
  mock.createEntry.mockResolvedValue(entry); mock.readEntry.mockResolvedValue(entry)
  mock.updateEntry.mockImplementation(async ({ data }: { data: Record<string, unknown> }): Promise<object> => ({ ...entry, ...data, revision: 2 }))
  app = Fastify(); await app.register(sensible); await app.register(libraryRoutes, { prefix: '/api' })
})
afterEach(async (): Promise<void> => { await app.close(); vi.unstubAllGlobals() })

describe('catalog library binding', () => {
  it('creates an acquisition record and promotes the upload grant without creating an author', async (): Promise<void> => {
    const result = await create()
    expect(result.statusCode, result.body).toBe(201)
    expect(result.json()).toMatchObject({ sourceKind: 'catalog', sourceOrigin: entry.sourceOrigin, sourceSkillId: source.skillId, sourceVersionId: source.version, authorSkillId: null })
    expect(mock.createEntry).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      sourceKind: 'catalog', sourceOrigin: entry.sourceOrigin, sourceSkillId: source.skillId, sourceVersionId: source.version, authorSkillId: null,
    }) }))
    expect(mock.raw.mock.calls[0].slice(1)).toEqual(['owner', card.sha256, 'catalog', `catalog:${source.skillId}@${source.version}`, 'catalog'])
    expect(mock.grant).toHaveBeenCalledTimes(2)
  })
  it.each([
    [503, null, 'CATALOG_UNREACHABLE', 503],
    [404, null, 'CATALOG_NOT_AVAILABLE', 409],
    [200, { ...metadata, status: 'rejected' }, 'CATALOG_NOT_AVAILABLE', 409],
    [200, { ...metadata, withdrawnAt: '2026-10-18' }, 'CATALOG_NOT_AVAILABLE', 409],
    [200, { ...metadata, version: { ...metadata.version, version: '0.2.0' } }, 'CATALOG_MISMATCH', 409],
    [200, { ...metadata, version: { ...metadata.version, packageSha256: 'b'.repeat(64) } }, 'CATALOG_MISMATCH', 409],
  ] as const)('maps upstream %s to %s / %s', async (status, body, code, expected): Promise<void> => {
    mock.fetch.mockImplementation(async (): Promise<Response> => Response.json(body, { status }))
    const result = await create()
    expect(result.statusCode).toBe(expected); expect(result.json().code).toBe(code)
    expect(mock.createEntry).not.toHaveBeenCalled(); expect(mock.raw).not.toHaveBeenCalled()
  })
  it('returns 503 for unreachable official service', async (): Promise<void> => {
    mock.fetch.mockRejectedValue(new Error('unreachable'))
    const result = await create()
    expect(result.statusCode).toBe(503); expect(result.json().code).toBe('CATALOG_UNREACHABLE')
  })
  it.each([null, { reason: 'team', card }, { reason: 'authored', card }, { reason: 'catalog', card }])('requires an upload grant before contacting the catalog: %s', async (grant): Promise<void> => {
    mock.grant.mockResolvedValue(grant)
    expect((await create()).statusCode).toBe(403)
    expect(mock.fetch).not.toHaveBeenCalled(); expect(mock.createEntry).not.toHaveBeenCalled()
  })
  it('rechecks upload ownership inside the transaction', async (): Promise<void> => {
    mock.grant.mockResolvedValueOnce({ reason: 'upload', card }).mockResolvedValue(null)
    expect((await create()).statusCode).toBe(403); expect(mock.createEntry).not.toHaveBeenCalled()
  })
  it('rejects catalog on official profile, including requests that could replay', async (): Promise<void> => {
    mock.profile = 'yitan-official'; mock.firstEntry.mockResolvedValue(entry)
    expect((await create()).statusCode).toBe(400)
    expect((await update({ baseRevision: 1, source })).statusCode).toBe(400)
    expect(mock.fetch).not.toHaveBeenCalled()
  })
  it('rejects forged provenance, legacy migration keys and extra source fields', async (): Promise<void> => {
    for (const body of [
      { ...payload, source: { kind: 'card', cardSha256: card.sha256, provenance: { sourceKind: 'catalog' } } },
      { ...payload, migrationKey: `marketplace:${source.skillId}` },
      { ...payload, source: { ...source, sourceOrigin: 'https://attacker.test' } },
      { ...payload, source: { ...source, skillId: 'not-a-uuid' } },
    ]) expect((await create(body)).statusCode).toBe(400)
    expect(mock.fetch).not.toHaveBeenCalled(); expect(mock.createEntry).not.toHaveBeenCalled()
  })
  it('returns the existing active entry for another client id, like marketplace migration replay', async (): Promise<void> => {
    mock.firstEntry.mockResolvedValueOnce(null).mockResolvedValueOnce(entry)
    const result = await create({ ...payload, id: 'c1c1c1c1-0000-4000-8000-000000000001' })
    expect(result.statusCode).toBe(200); expect(result.json().id).toBe(id)
    expect(mock.fetch).not.toHaveBeenCalled(); expect(mock.createEntry).not.toHaveBeenCalled()
  })
  it('uses cached metadata across binds but still compares each hash', async (): Promise<void> => {
    expect((await create()).statusCode).toBe(201)
    expect((await create()).statusCode).toBe(201)
    expect(mock.fetch).toHaveBeenCalledTimes(1)
    mock.grant.mockResolvedValue({ reason: 'upload', card: { sha256: 'b'.repeat(64) } })
    const mismatched = await create({ ...payload, source: { ...source, packageSha256: 'b'.repeat(64) } })
    expect(mismatched.json().code).toBe('CATALOG_MISMATCH')
  })
  it('denies conversion to an author asset even if a legacy author pointer exists', async (): Promise<void> => {
    mock.findEntry.mockResolvedValue({ ...entry, authorSkillId: 'legacy-pointer' })
    const result = await app.inject({ method: 'POST', url: `/api/library/${id}/author-asset`, payload: {} })
    expect(result.statusCode).toBe(409)
    expect(result.json()).toEqual({ code: 'CATALOG_NOT_AUTHORED', error: '来自官方商店的 Skill 不能作为自己的作品发布或共享' })
    expect(mock.updateEntry).not.toHaveBeenCalled()
  })
  it('validates updates before accepting a new card/version and leaves failures unchanged', async (): Promise<void> => {
    mock.findEntry.mockResolvedValue(entry)
    const next = { ...source, version: '0.2.0', packageSha256: 'c'.repeat(64) }
    mock.grant.mockResolvedValue({ reason: 'upload', card: { sha256: next.packageSha256 } })
    mock.fetch.mockImplementation(async (): Promise<Response> => Response.json({ ...metadata, version: { version: next.version, packageSha256: next.packageSha256 } }))
    const result = await update({ baseRevision: 1, source: next })
    expect(result.statusCode, result.body).toBe(200)
    expect(mock.updateEntry).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cardSha256: next.packageSha256, sourceVersionId: next.version, sourceOrigin: entry.sourceOrigin }) }))
    mock.updateEntry.mockClear()
    const failed = await update({ baseRevision: 1, source: { ...next, version: '0.3.0' } })
    expect(failed.json().code).toBe('CATALOG_MISMATCH'); expect(mock.updateEntry).not.toHaveBeenCalled()
  })
  it('allows profile edits offline but forbids changing catalog kind, identity, or replacing its card directly', async (): Promise<void> => {
    mock.findEntry.mockResolvedValue(entry)
    expect((await update({ baseRevision: 1, profile: { displayName: 'Personal label' } })).statusCode).toBe(200)
    for (const replacement of [
      { kind: 'card', cardSha256: card.sha256 }, { kind: 'marketplace', skillId: source.skillId },
      { kind: 'authored', skillId: source.skillId }, { ...source, skillId: 'c1c1c1c1-0000-4000-8000-000000000001' },
    ]) {
      const result = await update({ baseRevision: 1, source: replacement })
      expect(result.statusCode).toBe(409); expect(result.json().code).toBe('CATALOG_SOURCE_IMMUTABLE')
    }
    mock.findEntry.mockResolvedValue({ ...entry, sourceKind: 'local', sourceOrigin: null })
    expect((await update({ baseRevision: 1, source })).json().code).toBe('CATALOG_SOURCE_IMMUTABLE')
    expect(mock.fetch).not.toHaveBeenCalled()
  })
  it('rejects restoring a second active catalog binding', async (): Promise<void> => {
    mock.findEntry.mockResolvedValue({ ...entry, deletedAt: new Date() }); mock.firstEntry.mockResolvedValue(entry)
    const result = await app.inject({ method: 'POST', url: `/api/library/${id}/restore`, payload: { baseRevision: 1 } })
    expect(result.statusCode).toBe(409); expect(mock.updateEntry).not.toHaveBeenCalled()
  })
  it('handles a winner committing between the initial lookup and upload check', async (): Promise<void> => {
    mock.firstEntry.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(entry)
    mock.grant.mockResolvedValue({ reason: 'catalog', uploadedAt: new Date(), card })
    const result = await create()
    expect(result.statusCode, result.body).toBe(200); expect(result.json().id).toBe(id)
    expect(mock.createEntry).not.toHaveBeenCalled(); expect(mock.raw).not.toHaveBeenCalled()
  })
  it.each(['team', 'marketplace', 'authored', 'catalog'])('accepts independently proven uploads even with an existing %s grant', async (reason): Promise<void> => {
    mock.grant.mockResolvedValue({ reason, uploadedAt: new Date(), card })
    expect((await create()).statusCode).toBe(201)
  })
  it('prevents laundering catalog bytes through plain card creation or a preexisting local entry', async (): Promise<void> => {
    mock.grant.mockResolvedValue({ reason: 'catalog', uploadedAt: new Date(), card })
    const result = await create({ ...payload, source: { kind: 'card', cardSha256: card.sha256 } })
    expect(result.statusCode).toBe(409); expect(result.json().code).toBe('CATALOG_NOT_AUTHORED')
    mock.findEntry.mockResolvedValue({ ...entry, sourceKind: 'local', sourceOrigin: null })
    const denied = await app.inject({ method: 'POST', url: `/api/library/${id}/author-asset`, payload: {} })
    expect(denied.statusCode).toBe(409); expect(denied.json().code).toBe('CATALOG_NOT_AUTHORED')
  })
})
