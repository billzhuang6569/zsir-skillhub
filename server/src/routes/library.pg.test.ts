import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { PrismaClient } from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const postgresUrl = process.env['SKILLHUB_PG_TEST_URL']
const AUTHOR = 'a1a1a1a1-0000-4000-8000-000000000001'
const MEMBER = 'a1a1a1a1-0000-4000-8000-000000000002'
const STRANGER = 'a1a1a1a1-0000-4000-8000-000000000003'
const USERS = [AUTHOR, MEMBER, STRANGER]
const TEAM_ID = 'a1a1a1a1-0000-4000-8000-0000000000aa'

const mockConfig = vi.hoisted(() => ({
  SKILLHUB_PROFILE: 'yitan-official',
  CATALOG_ORIGIN: 'https://catalog.example.test/skillhub',
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

type ZipFile = { path: string; content: string; executable?: boolean; modified?: number }

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Minimal stored (uncompressed) ZIP writer that can vary timestamps and modes. */
function zip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const data = Buffer.from(file.content, 'utf8')
    const crc = crc32(data)
    const time = file.modified ?? 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(time, 10)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(time, 12)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((file.executable ? 0o100755 : 0o100644) * 0x10000) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralBytes = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBytes.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, eocd])
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function skillZip(label: string, extra: ZipFile[] = []): Buffer {
  return zip([{ path: 'SKILL.md', content: `# ${label}\n` }, ...extra])
}

const profile = { displayName: 'Synced Skill', labels: ['同步'], envDependencies: [{ key: 'API_TOKEN', required: true }] }

const describePostgres = postgresUrl ? describe : describe.skip

describePostgres('PostgreSQL Skill card library', () => {
  let app: FastifyInstance
  let prisma: PrismaClient

  async function cleanup(): Promise<void> {
    await prisma.libraryEntry.updateMany({ where: { userId: { in: USERS } }, data: { currentVersionReceiptId: null } })
    await prisma.skill.updateMany({ where: { authorId: { in: USERS } }, data: { importVersionId: null } })
    await prisma.skillVersionLabelAlias.deleteMany({ where: { version: { skill: { authorId: { in: USERS } } } } })
    await prisma.libraryEntry.deleteMany({ where: { userId: { in: USERS } } })
    await prisma.cardGrant.deleteMany({ where: { userId: { in: USERS } } })
    await prisma.skill.deleteMany({ where: { authorId: { in: USERS } } })
    await prisma.skillCard.deleteMany({ where: { createdById: { in: USERS } } })
    await prisma.team.deleteMany({ where: { id: TEAM_ID } })
    await prisma.user.deleteMany({ where: { id: { in: USERS } } })
  }

  function as(userId: string): { 'x-test-user': string } {
    return { 'x-test-user': userId }
  }

  async function patchEntry(id: string, payload: Record<string, unknown>, user = AUTHOR): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await app.inject({ method: 'PUT', url: `/api/library/${id}`, headers: as(user), payload })
    return { status: response.statusCode, body: response.json() }
  }

  it('allocates immutable receipts, preserves old retries and clears only the current pointer for old clients', async () => {
    const a = await uploadCard(AUTHOR, skillZip('receipt-a'))
    const b = await uploadCard(AUTHOR, skillZip('receipt-b'))
    const id = randomUUID()
    const source = { kind: 'card', cardSha256: a.body.sha256 }
    const created = await createEntry(AUTHOR, { id, name: 'receipts', profile, source })
    expect(created.body).toMatchObject({ version: null, versionHighWater: -1, versionPolicy: 1 })
    const intent = { kind: 'save', requestId: randomUUID(), cardSha256: a.body.sha256, allocation: 'auto', label: '0.1.0' }
    const winners = await Promise.all([patchEntry(id, { baseRevision: 1, versionIntent: intent }), patchEntry(id, { baseRevision: 1, versionIntent: { ...intent, requestId: randomUUID() } })])
    expect(winners.map((r) => r.status).sort()).toEqual([200, 409])
    const current = winners.find((r) => r.status === 200)!.body
    expect(current.version).toMatchObject({ label: '0.1.0', cardSha256: a.body.sha256 })
    const receipt = current.version as { receiptId: string }
    const changed = await patchEntry(id, { baseRevision: current.revision, source: { kind: 'card', cardSha256: b.body.sha256 } })
    expect(changed.body).toMatchObject({ version: null, versionHighWater: 10 })
    const save = await patchEntry(id, { baseRevision: changed.body.revision, versionIntent: { ...intent, requestId: randomUUID(), cardSha256: b.body.sha256 } })
    expect(save.body.version).toMatchObject({ label: '0.1.1' })
    const historicalIntent = { ...intent, requestId: receipt.receiptId }
    const replay = await patchEntry(id, { baseRevision: 1, source, versionIntent: historicalIntent })
    expect(replay.status).toBe(200)
    expect(replay.body.version).toMatchObject({ label: '0.1.1' })
    expect(replay.body.acceptedVersionReceipt).toMatchObject({ receiptId: receipt.receiptId, label: '0.1.0' })
    expect((await patchEntry(id, { versionIntent: { ...historicalIntent, label: '0.1.2' } })).body.code).toBe('VERSION_REQUEST_CONFLICT')
    const listed = await app.inject({ method: 'GET', url: `/api/library/${id}/receipts`, headers: as(AUTHOR) })
    expect(listed.json().receipts).toHaveLength(2)
    expect((await app.inject({ method: 'GET', url: `/api/library/${id}/receipts`, headers: as(STRANGER) })).statusCode).toBe(404)
    expect(await prisma.skillVersion.count()).toBe(0)
  })

  it('keeps manually entered source across legacy profile saves and version creation', async () => {
    const data = skillZip('source-compatibility')
    const card = await uploadCard(AUTHOR, data)
    const id = randomUUID()
    const sourceUrl = 'https://github.com/example/original'
    const created = await createEntry(AUTHOR, { id, name: 'source-compatibility', profile: { ...profile, sourceUrl }, source: { kind: 'card', cardSha256: card.body.sha256 } })
    expect(created.statusCode).toBe(201)
    const saved = await patchEntry(id, { baseRevision: 1, profile: { ...profile, displayName: 'Legacy edit' } })
    expect(saved.status).toBe(200)
    expect(saved.body.profile).toMatchObject({ sourceUrl })
    const cleared = await patchEntry(id, { baseRevision: saved.body.revision, profile: { ...profile, sourceUrl: '' } })
    expect(cleared.status).toBe(200)
    expect(cleared.body.profile).toMatchObject({ sourceUrl: null })

    const asset = await legacySkill(AUTHOR, 'formal-source', data)
    await prisma.skill.update({ where: { id: asset.skillId }, data: { currentVersion: '0.1.0', sourceUrl } })
    await prisma.skillVersion.update({ where: { id: asset.versionId }, data: { version: '0.1.0', sourceUrl } })
    const patched = await app.inject({ method: 'PATCH', url: `/api/skills/${asset.skillId}`, headers: as(AUTHOR), payload: { displayName: 'Old APP edit' } })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(patched.json().sourceUrl).toBe(sourceUrl)
    const next = await app.inject({ method: 'POST', url: `/api/skills/${asset.skillId}/versions`, headers: as(AUTHOR), payload: { version: '0.1.1', skillMd: '# source-compatibility\n', packageBase64: data.toString('base64'), packageSha256: sha256(data) } })
    expect(next.statusCode, next.body).toBe(201)
    expect((await prisma.skillVersion.findUniqueOrThrow({ where: { id: next.json().id } })).sourceUrl).toBe(sourceUrl)
    const syncedId = randomUUID()
    const versionIntent = { kind: 'formal', versionId: next.json().id }
    const synced = await createEntry(AUTHOR, { id: syncedId, name: 'formal-copy', profile, source: { kind: 'authored', skillId: asset.skillId }, versionIntent })
    expect(synced.statusCode).toBe(201)
    expect(synced.body.profile).toMatchObject({ sourceUrl })
    const custom = await patchEntry(syncedId, { baseRevision: synced.body.revision, profile: { ...profile, sourceUrl: 'https://example.test/custom' }, versionIntent })
    expect(custom.status).toBe(200)
    const legacySync = await patchEntry(syncedId, { baseRevision: custom.body.revision, profile, versionIntent })
    expect(legacySync.status).toBe(200)
    expect(legacySync.body.profile).toMatchObject({ sourceUrl: 'https://example.test/custom' })
  })

  it('keeps personal numbering when a later upstream formal version uses its label', async () => {
    const first = skillZip('upstream-first')
    const initial = await legacySkill(AUTHOR, 'upstream', first)
    await uploadCard(AUTHOR, first)
    await prisma.skillVersion.update({ where: { id: initial.versionId }, data: { version: '2.3.0', cardSha256: sha256(first) } })
    await prisma.skill.update({ where: { id: initial.skillId }, data: { currentVersion: '2.3.0' } })
    await listSkill(initial.skillId, initial.versionId)
    const id = randomUUID()
    const entry = await createEntry(MEMBER, { id, name: 'source', profile, source: { kind: 'marketplace', skillId: initial.skillId } })
    expect(entry.body.sourceVersionId).toBe(initial.versionId)
    let result = await patchEntry(id, { baseRevision: entry.body.revision, versionIntent: { kind: 'formal', versionId: initial.versionId } }, MEMBER)
    expect(result.body.version).toMatchObject({ label: '2.3.0', formalLabel: '2.3.0' })
    const personal = await uploadCard(MEMBER, skillZip('personal'))
    result = await patchEntry(id, { baseRevision: result.body.revision, source: { kind: 'card', cardSha256: personal.body.sha256 }, versionIntent: { kind: 'save', requestId: randomUUID(), allocation: 'auto', label: '0.1.0', cardSha256: personal.body.sha256 } }, MEMBER)
    expect(result.body.version).toMatchObject({ label: '2.3.1', formalVersionId: null })
    const newer = skillZip('upstream-next')
    await uploadCard(AUTHOR, newer)
    await uploadCard(MEMBER, newer)
    const version = await prisma.skillVersion.create({ data: { skillId: initial.skillId, version: '2.3.1', cardSha256: sha256(newer), packageData: newer, packageSha256: sha256(newer), packageSize: newer.length } })
    await prisma.marketplaceListing.deleteMany({ where: { skillId: initial.skillId } })
    await listSkill(initial.skillId, version.id)
    result = await patchEntry(id, { baseRevision: result.body.revision, source: { kind: 'card', cardSha256: sha256(newer) }, versionIntent: { kind: 'formal', versionId: version.id } }, MEMBER)
    expect(result.body.version).toMatchObject({ label: '2.3.2', formalLabel: '2.3.1', formalVersionId: version.id })
    const repeated = await patchEntry(id, { baseRevision: result.body.revision, versionIntent: { kind: 'formal', versionId: version.id } }, MEMBER)
    expect(repeated.body.version).toEqual(result.body.version)
    expect(await prisma.libraryEntryVersion.count({ where: { entryId: id } })).toBe(3)
    const { planVersionLabels, applyVersionLabels } = await import('../ops/version-labels.js')
    const immutableReceipts = await prisma.libraryEntryVersion.findMany({ where: { entryId: id }, orderBy: { id: 'asc' } })
    const grants = await prisma.cardGrant.findMany({ orderBy: [{ userId: 'asc' }, { cardSha256: 'asc' }] })
    const cards = await prisma.skillCard.findMany({ orderBy: { sha256: 'asc' } })
    const oldEntry = await prisma.libraryEntry.findUniqueOrThrow({ where: { id } })
    await prisma.skillVersion.update({ where: { id: version.id }, data: { version: 'v2.3.1' } })
    const plan = await planVersionLabels(prisma, 30)
    await applyVersionLabels(prisma, plan, plan.planDigest)
    expect(await prisma.libraryEntryVersion.findMany({ where: { entryId: id }, orderBy: { id: 'asc' } })).toEqual(immutableReceipts)
    expect(await prisma.cardGrant.findMany({ orderBy: [{ userId: 'asc' }, { cardSha256: 'asc' }] })).toEqual(grants)
    expect(await prisma.skillCard.findMany({ orderBy: { sha256: 'asc' } })).toEqual(cards)
    expect(await prisma.libraryEntry.findUniqueOrThrow({ where: { id } })).toMatchObject({ currentVersionReceiptId: oldEntry.currentVersionReceiptId, cardSha256: oldEntry.cardSha256, versionHighWater: oldEntry.versionHighWater, revision: oldEntry.revision + 1 })
  })

  it('migrates legacy labels with immutable IDs, alias retries, idempotence and reverse CAS', async () => {
    const { planVersionLabels, applyVersionLabels } = await import('../ops/version-labels.js')
    const source = skillZip('migration-original')
    const first = await legacySkill(AUTHOR, 'migration', source)
    const second = await prisma.skillVersion.create({ data: { skillId: first.skillId, version: '0.1.0', packageData: source, packageSha256: sha256(source), packageSize: source.length, createdAt: new Date(Date.now() + 1000) } })
    await prisma.skill.update({ where: { id: first.skillId }, data: { currentVersion: second.version } })
    const before = await prisma.skillVersion.findMany({ where: { skillId: first.skillId }, orderBy: { id: 'asc' } })
    const plan = await planVersionLabels(prisma, 30)
    expect(plan.blockers).toEqual([])
    expect(await applyVersionLabels(prisma, plan, plan.planDigest)).toBe('applied')
    expect(await applyVersionLabels(prisma, plan, plan.planDigest)).toBe('unchanged')
    const after = await prisma.skillVersion.findMany({ where: { skillId: first.skillId }, orderBy: { id: 'asc' } })
    expect(after.map(({ version: _version, ...row }) => row)).toEqual(before.map(({ version: _version, ...row }) => row))
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: first.skillId } })).currentVersion).toBe('0.1.1')
    expect(await applyVersionLabels(prisma, plan, plan.planDigest, true)).toBe('rolled_back')
    expect(await applyVersionLabels(prisma, plan, plan.planDigest, true)).toBe('unchanged')
    expect(await prisma.skillVersionLabelAlias.count()).toBe(0)
    const again = await planVersionLabels(prisma, 30)
    await applyVersionLabels(prisma, again, again.planDigest)
    await prisma.skill.update({ where: { id: first.skillId }, data: { description: 'new write' } })
    expect(await applyVersionLabels(prisma, again, again.planDigest, true)).toBe('rolled_back')
    const third = await planVersionLabels(prisma, 30)
    await applyVersionLabels(prisma, third, third.planDigest)
    await prisma.skillVersion.create({ data: { skillId: first.skillId, version: '0.1.2' } })
    await expect(applyVersionLabels(prisma, third, third.planDigest, true)).rejects.toThrow('state changed')
  })

  it('rejects new legacy labels, preserves exact aliased retries and binds reserved author receipts', async () => {
    const { planVersionLabels, applyVersionLabels } = await import('../ops/version-labels.js')
    const data = skillZip('formal')
    const hash = sha256(data)
    await uploadCard(AUTHOR, data)
    const id = randomUUID()
    const entry = await createEntry(AUTHOR, { id, name: 'formal', profile, source: { kind: 'card', cardSha256: hash } })
    const saved = await patchEntry(id, { baseRevision: entry.body.revision, versionIntent: { kind: 'save', requestId: randomUUID(), allocation: 'manual', label: '0.0.0', cardSha256: hash } })
    const publish = await app.inject({ method: 'POST', url: `/api/library/${id}/author-asset`, headers: as(AUTHOR), payload: { baseRevision: saved.body.revision } })
    expect(publish.statusCode).toBe(201)
    const skill = await prisma.skill.findFirstOrThrow({ where: { authorId: AUTHOR, name: 'formal' } })
    expect(skill.currentVersion).toBe('0.0.0')
    const next = skillZip('formal-next')
    await uploadCard(AUTHOR, next)
    const current = await prisma.libraryEntry.findUniqueOrThrow({ where: { id } })
    const reserved = await patchEntry(id, { baseRevision: current.revision, source: { kind: 'card', cardSha256: sha256(next) }, versionIntent: { kind: 'save', requestId: randomUUID(), allocation: 'manual', label: '0.0.1', cardSha256: sha256(next) } })
    const payload = { version: '0.0.1', libraryVersionReceiptId: (reserved.body.version as { receiptId: string }).receiptId, skillMd: '# formal-next\n', packageBase64: next.toString('base64'), packageSha256: sha256(next), changelog: 'next' }
    const send = async (body: Record<string, unknown>): Promise<ReturnType<typeof app.inject>> => app.inject({ method: 'POST', url: `/api/skills/${skill.id}/versions`, headers: as(AUTHOR), payload: body })
    const formal = await send(payload)
    expect(formal.statusCode).toBe(201)
    expect((await send(payload)).statusCode).toBe(200)
    expect((await send({ ...payload, version: 'v0.0.2' })).json().code).toBe('VERSION_FORMAT_INVALID')
    expect((await send({ ...payload, changelog: 'changed' })).json().code).toBe('VERSION_REQUEST_CONFLICT')
    // Synthetic legacy history preserves the request digest from its original label.
    const { versionMutationDigest } = await import('./skills.js')
    await prisma.skillVersion.update({ where: { id: formal.json().id }, data: { version: 'v0.0.1', mutationDigest: versionMutationDigest({ ...payload, version: 'v0.0.1' }, sha256(next)) } })
    await prisma.skill.update({ where: { id: skill.id }, data: { currentVersion: 'v0.0.1' } })
    const plan = await planVersionLabels(prisma, 30)
    expect(plan.blockers).toEqual([])
    await applyVersionLabels(prisma, plan, plan.planDigest)
    const retry = await send({ ...payload, version: 'v0.0.1' })
    expect(retry.statusCode).toBe(200)
    expect(retry.json()).toMatchObject({ id: formal.json().id, version: '0.0.1', aliases: ['v0.0.1'] })
    expect(retry.json()).not.toHaveProperty('mutationDigest')
    expect(await prisma.skillVersion.count({ where: { skillId: skill.id } })).toBe(2)
  })

  it('fails unmigrated formal binds atomically and enforces composite receipt ownership', async () => {
    const data = skillZip('unmigrated')
    const legacy = await legacySkill(AUTHOR, 'unmigrated', data)
    await uploadCard(AUTHOR, data)
    await prisma.skillVersion.update({ where: { id: legacy.versionId }, data: { cardSha256: sha256(data) } })
    const first = await createEntry(AUTHOR, { id: randomUUID(), name: 'first', profile, source: { kind: 'card', cardSha256: sha256(data) } })
    const rejected = await patchEntry(String(first.body.id), { baseRevision: 1, versionIntent: { kind: 'formal', versionId: legacy.versionId } })
    expect(rejected.body.code).toBe('VERSION_LABEL_MIGRATION_REQUIRED')
    expect(rejected.body.entry).toMatchObject({ id: first.body.id, revision: 1, version: null })
    expect(await prisma.libraryEntryVersion.count()).toBe(0)
    expect((await prisma.libraryEntry.findUniqueOrThrow({ where: { id: String(first.body.id) } })).revision).toBe(1)
    const second = await createEntry(AUTHOR, { id: randomUUID(), name: 'second', profile, source: { kind: 'card', cardSha256: sha256(data) }, versionIntent: { kind: 'save', requestId: randomUUID(), allocation: 'auto', label: '0.1.0', cardSha256: sha256(data) } })
    const foreign = (second.body.version as { receiptId: string }).receiptId
    await expect(prisma.libraryEntry.update({ where: { id: String(first.body.id) }, data: { currentVersionReceiptId: foreign } })).rejects.toThrow()
  })

  it('charges historical receipt cards after the upload grace period', async () => {
    const first = skillZip('charged-old')
    const next = skillZip('charged-new')
    await uploadCard(AUTHOR, first)
    await uploadCard(AUTHOR, next)
    const id = randomUUID()
    const created = await createEntry(AUTHOR, { id, name: 'charged', profile, source: { kind: 'card', cardSha256: sha256(first) }, versionIntent: { kind: 'save', requestId: randomUUID(), allocation: 'auto', label: '0.1.0', cardSha256: sha256(first) } })
    await patchEntry(id, { baseRevision: created.body.revision, source: { kind: 'card', cardSha256: sha256(next) } })
    await prisma.skillCard.updateMany({ where: { createdById: AUTHOR }, data: { createdAt: new Date(0) } })
    mockConfig.SKILL_MAX_STORAGE_BYTES_PER_USER = first.length + next.length
    expect((await uploadCard(AUTHOR, skillZip('over-quota'))).statusCode).toBe(413)
  })

  it('binds an acquired team version after revocation without granting access to other versions', async () => {
    const data = skillZip('team-version')
    const skill = await legacySkill(AUTHOR, 'team-version', data)
    await uploadCard(AUTHOR, data)
    await prisma.skillVersion.update({ where: { id: skill.versionId }, data: { version: '0.1.0', cardSha256: sha256(data) } })
    await prisma.skill.update({ where: { id: skill.skillId }, data: { currentVersion: '0.1.0' } })
    await prisma.skillTeamShare.create({ data: { skillId: skill.skillId, teamId: TEAM_ID, sharedById: AUTHOR } })
    const id = randomUUID()
    const created = await createEntry(MEMBER, { id, name: 'team-version', profile, source: { kind: 'team', skillId: skill.skillId, teamId: TEAM_ID } })
    expect(created.statusCode).toBe(201)
    mockConfig.SKILLHUB_PROFILE = 'selfhost'
    const catalogSource = { kind: 'catalog', skillId: randomUUID(), version: '0.1.0', packageSha256: sha256(data) }
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => Response.json({ id: catalogSource.skillId, version: { version: catalogSource.version, packageSha256: catalogSource.packageSha256 } })))
    const catalogBody = { id: randomUUID(), name: 'same-official-bytes', profile, source: catalogSource }
    expect((await createEntry(MEMBER, catalogBody)).statusCode).toBe(403)
    await uploadCard(MEMBER, data)
    expect((await createEntry(MEMBER, catalogBody)).statusCode).toBe(201)
    expect(await prisma.cardGrant.findUniqueOrThrow({ where: { userId_cardSha256: { userId: MEMBER, cardSha256: sha256(data) } } })).toMatchObject({
      reason: 'catalog', priorSourceRef: `version:${skill.versionId}`, uploadedAt: expect.any(Date),
    })
    await prisma.skillTeamShare.deleteMany({ where: { skillId: skill.skillId } })
    const bound = await patchEntry(id, { baseRevision: 1, versionIntent: { kind: 'formal', versionId: skill.versionId } }, MEMBER)
    expect(bound.status).toBe(200)
    const privateVersion = await prisma.skillVersion.create({ data: { skillId: skill.skillId, version: '0.1.1', cardSha256: sha256(data) } })
    const denied = await patchEntry(id, { baseRevision: bound.body.revision, versionIntent: { kind: 'formal', versionId: privateVersion.id } }, MEMBER)
    expect(denied.status).toBe(403)
  })

  it('records immutable import provenance and never guesses it from a single surviving version', async () => {
    const data = skillZip('import-evidence')
    const payload = { name: 'import-evidence', skillMd: '# import-evidence\n', packageBase64: data.toString('base64'), packageSha256: sha256(data), compatibleAgents: ['codex'], aiAnalysisConsent: true }
    const send = async (body: Record<string, unknown>): Promise<ReturnType<typeof app.inject>> => app.inject({ method: 'POST', url: '/api/skills/import', headers: as(AUTHOR), payload: body })
    const created = await send(payload)
    expect(created.statusCode).toBe(201)
    const skill = await prisma.skill.findUniqueOrThrow({ where: { id: created.json().skill.id } })
    expect(skill.importVersionId).not.toBeNull()
    expect((await send(payload)).json()).toMatchObject({ recovered: true })
    await prisma.skill.update({ where: { id: skill.id }, data: { importVersionId: null } })
    expect((await send(payload)).json().code).toBe('IMPORT_RECOVERY_UNVERIFIABLE')
    expect((await send({ ...payload, name: 'old-new-write', currentVersion: 'v0.1.0' })).json().code).toBe('VERSION_FORMAT_INVALID')
  })

  it('reports quota and current-pointer anomalies even when canonical labels need no rename', async () => {
    const { planVersionLabels, applyVersionLabels } = await import('../ops/version-labels.js')
    const versions = Array.from({ length: 31 }, (_, index) => ({ version: `0.${Math.floor((index + 10) / 10)}.${index % 10}`, createdAt: new Date(1_000 + index) }))
    const overQuota = await prisma.skill.create({ data: { authorId: AUTHOR, name: 'canonical-over-quota', displayName: 'Canonical', currentVersion: '0.4.0', versions: { create: versions } } })
    const dangling = await prisma.skill.create({ data: { authorId: AUTHOR, name: 'canonical-dangling-current', displayName: 'Dangling', currentVersion: '0.1.1', versions: { create: { version: '0.1.0' } } } })
    const plan = await planVersionLabels(prisma, 30)
    expect(plan.changes).toEqual([])
    expect(plan.before.skills).toEqual([])
    expect(plan.blockers).toEqual(expect.arrayContaining([
      `${overQuota.id}: 31 formal versions exceeds quota 30; review required`,
      `${dangling.id}: current version is not unique`,
    ]))
    expect(plan.blockers).toHaveLength(2)
    await expect(applyVersionLabels(prisma, plan, plan.planDigest)).rejects.toThrow('unresolved blockers')
    expect(await prisma.skillVersionLabelAlias.count()).toBe(0)
    expect(await prisma.skillVersion.count({ where: { skillId: overQuota.id } })).toBe(31)
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: dangling.id } })).currentVersion).toBe('0.1.1')
  })

  it('scopes migration CAS to affected version metadata and keeps unrelated writes', async () => {
    const { planVersionLabels, applyVersionLabels } = await import('../ops/version-labels.js')
    const source = skillZip('scoped-migration')
    const changed = await legacySkill(AUTHOR, 'needs-migration', source)
    const unrelated = await prisma.skill.create({ data: { authorId: STRANGER, name: 'already-valid', displayName: 'Already valid', currentVersion: '0.1.0', versions: { create: { version: '0.1.0' } } } })
    const plan = await planVersionLabels(prisma, 30)
    expect(plan.before.skills.map((skill) => skill.id)).toEqual([changed.skillId])
    await prisma.skill.update({ where: { id: changed.skillId }, data: { description: 'new profile', installCount: { increment: 1 } } })
    await prisma.skillVersion.update({ where: { id: changed.versionId }, data: { packageData: null } })
    await prisma.skill.update({ where: { id: unrelated.id }, data: { description: 'unrelated profile', versionHighWater: 888 } })
    expect(await applyVersionLabels(prisma, plan, plan.planDigest)).toBe('applied')
    expect(await applyVersionLabels(prisma, plan, plan.planDigest)).toBe('unchanged')
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: changed.skillId } })).description).toBe('new profile')
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: unrelated.id } })).versionHighWater).toBe(888)
    expect(await applyVersionLabels(prisma, plan, plan.planDigest, true)).toBe('rolled_back')
    const stale = await planVersionLabels(prisma, 30)
    await uploadCard(AUTHOR, source)
    await prisma.libraryEntry.create({ data: { id: randomUUID(), userId: AUTHOR, authorSkillId: changed.skillId, name: 'new-related-entry', cardSha256: sha256(source), requestDigest: 'fixture' } })
    await expect(applyVersionLabels(prisma, stale, stale.planDigest)).rejects.toThrow('state changed')
  })

  it('returns authorized current entries for version conflicts and treats same-card save as a no-op', async () => {
    const card = await uploadCard(AUTHOR, skillZip('no-op'))
    const other = await uploadCard(AUTHOR, skillZip('different'))
    const id = randomUUID()
    const source = { kind: 'card', cardSha256: card.body.sha256 }
    const intent = { kind: 'save', requestId: randomUUID(), allocation: 'manual', label: '9.9.9', cardSha256: card.body.sha256 }
    const created = await createEntry(AUTHOR, { id, name: 'no-op', profile, source, versionIntent: intent })
    expect(created.statusCode).toBe(201)
    const noop = await patchEntry(id, { baseRevision: 1, source, versionIntent: { ...intent, requestId: randomUUID(), label: 'legacy-invalid' } })
    expect(noop.status).toBe(200)
    expect(noop.body.revision).toBe(1)
    expect(noop.body.version).toEqual(created.body.version)
    expect(await prisma.libraryEntryVersion.count({ where: { entryId: id } })).toBe(1)
    const exhausted = await patchEntry(id, { baseRevision: 1, source: { kind: 'card', cardSha256: other.body.sha256 }, versionIntent: { ...intent, requestId: randomUUID(), allocation: 'auto', cardSha256: other.body.sha256 } })
    expect(exhausted.body).toMatchObject({ code: 'VERSION_RANGE_EXHAUSTED', entry: { id, revision: 1, version: { label: '9.9.9' } } })
    const denied = await patchEntry(id, { baseRevision: 1, versionIntent: intent }, STRANGER)
    expect(denied.status).toBe(404)
    expect(denied.body).not.toHaveProperty('entry')
    const profileOnly = await patchEntry(id, { baseRevision: 1, profile: { ...profile, displayName: 'updated' } })
    expect(profileOnly.body.version).toEqual(created.body.version)
  })

  it('uses an existing account receipt to prove a legacy team grant without exposing another formal UUID', async () => {
    const data = skillZip('legacy-team-proof')
    const source = await legacySkill(AUTHOR, 'legacy-team-proof', data)
    await uploadCard(AUTHOR, data)
    await prisma.skillVersion.update({ where: { id: source.versionId }, data: { version: '0.1.0', cardSha256: sha256(data) } })
    await prisma.skill.update({ where: { id: source.skillId }, data: { currentVersion: '0.1.0' } })
    await prisma.skillTeamShare.create({ data: { skillId: source.skillId, teamId: TEAM_ID, sharedById: AUTHOR } })
    const first = await createEntry(MEMBER, { id: randomUUID(), name: 'proof', profile, source: { kind: 'team', skillId: source.skillId, teamId: TEAM_ID }, versionIntent: { kind: 'formal', versionId: source.versionId } })
    expect(first.statusCode).toBe(201)
    await prisma.cardGrant.update({ where: { userId_cardSha256: { userId: MEMBER, cardSha256: sha256(data) } }, data: { sourceRef: `team:${TEAM_ID}` } })
    await prisma.skillTeamShare.deleteMany({ where: { skillId: source.skillId } })
    const second = await createEntry(MEMBER, { id: randomUUID(), name: 'restore-proven', profile, source: { kind: 'card', cardSha256: sha256(data) } })
    expect((await patchEntry(String(second.body.id), { baseRevision: 1, versionIntent: { kind: 'formal', versionId: source.versionId } }, MEMBER)).status).toBe(200)
    const privateVersion = await prisma.skillVersion.create({ data: { skillId: source.skillId, version: '0.1.1', cardSha256: sha256(data) } })
    expect((await patchEntry(String(second.body.id), { baseRevision: 2, versionIntent: { kind: 'formal', versionId: privateVersion.id } }, MEMBER)).status).toBe(403)
    const forbidden = await app.inject({ method: 'POST', url: `/api/skills/${source.skillId}/versions`, headers: as(MEMBER), payload: { version: '0.1.2', skillMd: '# legacy-team-proof\n', packageBase64: data.toString('base64'), packageSha256: sha256(data) } })
    expect(forbidden.statusCode).toBe(403)
  })

  it('blocks a migrated formal label reserved by another formal UUID even for identical cards', async () => {
    const { planVersionLabels, applyVersionLabels } = await import('../ops/version-labels.js')
    const data = skillZip('same-card-identity')
    await uploadCard(AUTHOR, data)
    const target = await legacySkill(AUTHOR, 'target-identity', data)
    const source = await legacySkill(AUTHOR, 'source-identity', data)
    await prisma.skillVersion.updateMany({ where: { id: { in: [target.versionId, source.versionId] } }, data: { cardSha256: sha256(data) } })
    const id = randomUUID()
    await prisma.libraryEntry.create({ data: { id, userId: AUTHOR, name: 'identity-reserved', cardSha256: sha256(data), profile, sourceKind: 'local', authorSkillId: target.skillId, requestDigest: 'fixture' } })
    await prisma.libraryEntryVersion.create({ data: { entryId: id, label: '0.1.0', cardSha256: sha256(data), formalVersionId: source.versionId } })
    const plan = await planVersionLabels(prisma, 30)
    expect(plan.blockers).toContain(`${target.skillId}: formal label collides with reserved content or version identity`)
    await expect(applyVersionLabels(prisma, plan, plan.planDigest)).rejects.toThrow('unresolved blockers')
    expect((await prisma.skillVersion.findUniqueOrThrow({ where: { id: target.versionId } })).version).toBe('v1.0')
  })

  async function uploadCard(userId: string, data: Buffer): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/cards',
      headers: as(userId),
      payload: { packageBase64: data.toString('base64'), packageSha256: sha256(data) },
    })
    return { statusCode: response.statusCode, body: response.json() }
  }

  async function createEntry(userId: string, payload: Record<string, unknown>): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const response = await app.inject({ method: 'POST', url: '/api/library', headers: as(userId), payload })
    return { statusCode: response.statusCode, body: response.json() }
  }

  async function legacySkill(authorId: string, name: string, data: Buffer): Promise<{ skillId: string; versionId: string }> {
    const skill = await prisma.skill.create({
      data: {
        name,
        displayName: name,
        authorId,
        currentVersion: 'v1.0',
        versions: {
          create: { version: 'v1.0', packageData: data, packageSha256: sha256(data), packageSize: data.length },
        },
      },
      include: { versions: true },
    })
    return { skillId: skill.id, versionId: skill.versions[0]?.id ?? '' }
  }

  async function listSkill(skillId: string, versionId: string): Promise<void> {
    const submission = await prisma.marketplaceSubmission.create({
      data: {
        skillId,
        versionId,
        submittedById: AUTHOR,
        status: 'approved',
        skillName: 'listed',
        displayName: 'Listed',
        sourceContent: '# Listed',
      },
    })
    await prisma.marketplaceListing.create({ data: { skillId, submissionId: submission.id, versionId } })
  }

  beforeAll(async () => {
    if (!postgresUrl) return
    prisma = new PrismaClient({ datasources: { db: { url: postgresUrl } } })
    vi.doMock('../db.js', () => ({ db: prisma }))
    vi.doMock('../config.js', () => ({ config: mockConfig }))
    vi.doMock('../middleware/auth.js', () => ({
      authMiddleware: async (request: FastifyRequest): Promise<void> => {
        const id = String(request.headers['x-test-user'] ?? AUTHOR)
        request.user = { id, email: `${id}@example.com`, displayName: id }
        request.verifiedAuthToken = { sub: id, ver: 0 } as typeof request.verifiedAuthToken
      },
    }))
    const [{ libraryRoutes }, { skillsRoutes }] = await Promise.all([
      import('./library.js'),
      import('./skills.js'),
    ])
    app = Fastify()
    await app.register(sensible)
    await app.register(libraryRoutes, { prefix: '/api' })
    await app.register(skillsRoutes, { prefix: '/api/skills' })
    await app.ready()
  })

  beforeEach(async () => {
    mockConfig.SKILLHUB_PROFILE = 'yitan-official'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected HTTP in library PG tests')))
    mockConfig.SKILL_CARD_STORAGE_DIR = mkdtempSync(join(tmpdir(), 'skillhub-library-pg-'))
    mockConfig.SKILL_MAX_PER_USER = 50
    mockConfig.SKILL_MAX_STORAGE_BYTES_PER_USER = 250 * 1024 * 1024
    await cleanup()
    await prisma.user.createMany({
      data: USERS.map((id) => ({ id, email: `${id}@example.com`, displayName: id })),
    })
    await prisma.team.create({
      data: {
        id: TEAM_ID,
        name: 'Sync Team',
        ownerId: AUTHOR,
        members: { create: [{ userId: AUTHOR, role: 'owner' }, { userId: MEMBER, role: 'member' }] },
      },
    })
  })

  afterAll(async () => {
    if (!postgresUrl) return
    await cleanup()
    await app?.close()
    await prisma?.$disconnect()
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('records a selfhost catalog acquisition, persists origin, and denies author rights', async (): Promise<void> => {
    mockConfig.SKILLHUB_PROFILE = 'selfhost'
    const data = skillZip('official-original')
    const source = { kind: 'catalog', skillId: randomUUID(), version: '0.1.0', packageSha256: sha256(data) }
    const fetcher = vi.fn(async (): Promise<Response> => Response.json({ id: source.skillId, version: { version: source.version, packageSha256: source.packageSha256 } }))
    vi.stubGlobal('fetch', fetcher)
    const id = randomUUID()
    expect((await createEntry(MEMBER, { id, name: 'official', profile, source })).statusCode).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
    await uploadCard(MEMBER, data)
    const created = await createEntry(MEMBER, { id, name: 'official', profile, source })
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201)
    expect(await prisma.libraryEntry.findUniqueOrThrow({ where: { id } })).toMatchObject({
      sourceKind: 'catalog', sourceOrigin: mockConfig.CATALOG_ORIGIN, sourceSkillId: source.skillId, sourceVersionId: source.version, authorSkillId: null,
    })
    expect(await prisma.cardGrant.findUniqueOrThrow({ where: { userId_cardSha256: { userId: MEMBER, cardSha256: source.packageSha256 } } })).toMatchObject({
      reason: 'catalog', sourceRef: `catalog:${source.skillId}@${source.version}`,
    })
    const denied = await app.inject({ method: 'POST', url: `/api/library/${id}/author-asset`, headers: as(MEMBER), payload: {} })
    expect(denied.statusCode).toBe(409); expect(denied.json().code).toBe('CATALOG_NOT_AUTHORED')
    expect(await prisma.skill.count({ where: { authorId: MEMBER } })).toBe(0)
    const imported = await app.inject({ method: 'POST', url: '/api/skills/import', headers: as(MEMBER), payload: {
      name: 'catalog-as-own-import', skillMd: '# official-original\n', currentVersion: '0.1.0', aiAnalysisConsent: true,
      packageBase64: data.toString('base64'), packageSha256: source.packageSha256,
    } })
    expect(imported.statusCode, imported.body).toBe(409); expect(imported.json().code).toBe('CATALOG_NOT_AUTHORED')
    expect(await prisma.skill.count({ where: { authorId: MEMBER } })).toBe(0)
    const oldAsset = await legacySkill(MEMBER, 'already-owned', data)
    const versioned = await app.inject({ method: 'POST', url: `/api/skills/${oldAsset.skillId}/versions`, headers: as(MEMBER), payload: {
      version: '0.2.0', skillMd: '# official-original\n', packageBase64: data.toString('base64'), packageSha256: source.packageSha256,
    } })
    expect(versioned.statusCode, versioned.body).toBe(409); expect(versioned.json().code).toBe('CATALOG_NOT_AUTHORED')
    expect(await prisma.skillVersion.count({ where: { skillId: oldAsset.skillId } })).toBe(1)
    const shared = await app.inject({ method: 'POST', url: `/api/skills/${oldAsset.skillId}/shares`, headers: as(MEMBER), payload: { teamId: TEAM_ID } })
    expect(shared.statusCode).toBe(409); expect(shared.json().code).toBe('CATALOG_NOT_AUTHORED')
    expect(await prisma.skillTeamShare.count({ where: { skillId: oldAsset.skillId } })).toBe(0)
    expect((await createEntry(MEMBER, { id, name: 'official', profile, source })).statusCode).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Reupload must never erase catalog provenance.
    expect((await uploadCard(MEMBER, data)).statusCode).toBe(200)
    expect(await prisma.cardGrant.findUniqueOrThrow({ where: { userId_cardSha256: { userId: MEMBER, cardSha256: source.packageSha256 } } })).toMatchObject({ reason: 'catalog', uploadedAt: expect.any(Date) })
    const laundered = await createEntry(MEMBER, { id: randomUUID(), name: 'pretend-local', profile, source: { kind: 'card', cardSha256: source.packageSha256 } })
    expect(laundered.statusCode).toBe(409); expect(laundered.body.code).toBe('CATALOG_NOT_AUTHORED')
    const next = { ...source, version: '0.2.0' }
    fetcher.mockImplementation(async (): Promise<Response> => Response.json({ id: source.skillId, version: { version: next.version, packageSha256: next.packageSha256 } }))
    const updated = await patchEntry(id, { baseRevision: 1, source: next }, MEMBER)
    expect(updated.status, JSON.stringify(updated.body)).toBe(200)
    expect(updated.body.sourceVersionId).toBe(next.version)
    const newerBytes = skillZip('official-new-bytes')
    await uploadCard(MEMBER, newerBytes)
    const newer = { ...source, version: '0.3.0', packageSha256: sha256(newerBytes) }
    fetcher.mockImplementation(async (): Promise<Response> => Response.json({ id: source.skillId, version: { version: newer.version, packageSha256: newer.packageSha256 } }))
    expect((await patchEntry(id, { baseRevision: updated.body.revision, source: newer }, MEMBER)).status).toBe(200)
    await prisma.libraryEntry.update({ where: { id }, data: { deletedAt: new Date() } })
    await uploadCard(MEMBER, data)
    expect((await createEntry(MEMBER, { id: randomUUID(), name: 'old-deleted-source', profile, source: { kind: 'card', cardSha256: source.packageSha256 } })).body.code).toBe('CATALOG_NOT_AUTHORED')
  })

  it('serializes concurrent catalog binds and prevents duplicate active rows even on restore', async (): Promise<void> => {
    mockConfig.SKILLHUB_PROFILE = 'selfhost'
    const data = skillZip('official-concurrent')
    const source = { kind: 'catalog', skillId: randomUUID(), version: '0.1.0', packageSha256: sha256(data) }
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => Response.json({ id: source.skillId, version: { version: source.version, packageSha256: source.packageSha256 } })))
    await uploadCard(MEMBER, data)
    const results = await Promise.all(Array.from({ length: 4 }, () => createEntry(MEMBER, { id: randomUUID(), name: 'official', profile, source })))
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 200, 200, 201])
    expect(new Set(results.map((result) => result.body.id)).size).toBe(1)
    const where = { userId: MEMBER, sourceKind: 'catalog', sourceSkillId: source.skillId, deletedAt: null }
    expect(await prisma.libraryEntry.count({ where })).toBe(1)
    const existing = await prisma.libraryEntry.findFirstOrThrow({ where })
    await expect(prisma.libraryEntry.create({ data: { ...existing, id: randomUUID() } })).rejects.toMatchObject({ code: 'P2002' })
    await prisma.libraryEntry.update({ where: { id: existing.id }, data: { deletedAt: new Date() } })
    await uploadCard(MEMBER, data)
    expect((await createEntry(MEMBER, { id: randomUUID(), name: 'official-again', profile, source })).statusCode).toBe(201)
    const restored = await app.inject({ method: 'POST', url: `/api/library/${existing.id}/restore`, headers: as(MEMBER), payload: { baseRevision: 1 } })
    expect(restored.statusCode).toBe(409)
    expect(await prisma.libraryEntry.count({ where })).toBe(1)
  })

  it('treats a card hash as data, never as an access credential', async () => {
    const data = skillZip('private')
    expect((await uploadCard(AUTHOR, data)).statusCode).toBe(201)
    const hash = sha256(data)

    const guessed = await app.inject({ method: 'GET', url: `/api/cards/${hash}`, headers: as(STRANGER) })
    expect(guessed.statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/cards/${hash}/meta`, headers: as(STRANGER) })).statusCode).toBe(404)

    const bare = await createEntry(STRANGER, {
      id: randomUUID(), name: 'stolen', profile, source: { kind: 'card', cardSha256: hash },
    })
    expect(bare.statusCode).toBe(403)

    const own = await uploadCard(STRANGER, skillZip('own'))
    const entryId = randomUUID()
    expect((await createEntry(STRANGER, {
      id: entryId, name: 'own', profile, source: { kind: 'card', cardSha256: own.body.sha256 },
    })).statusCode).toBe(201)
    const rebind = await app.inject({
      method: 'PUT',
      url: `/api/library/${entryId}`,
      headers: as(STRANGER),
      payload: { baseRevision: 1, source: { kind: 'card', cardSha256: hash } },
    })
    expect(rebind.statusCode).toBe(403)
    expect(await prisma.cardGrant.count({ where: { userId: STRANGER, cardSha256: hash } })).toBe(0)

    // Re-uploading the complete bytes of an existing card proves possession.
    const dedupe = await uploadCard(STRANGER, data)
    expect(dedupe.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/api/cards/${hash}`, headers: as(STRANGER) })).statusCode).toBe(200)
    const card = await prisma.skillCard.findUniqueOrThrow({ where: { sha256: hash } })
    expect(card.createdById).toBe(AUTHOR)
    expect(card.storageProvider).toBe('filesystem')
  })

  it('derives a container-independent content hash and executable paths', async () => {
    const first = zip([
      { path: 'SKILL.md', content: '# Exec\n', modified: 1 },
      { path: 'scripts/run.sh', content: 'echo ok\n', executable: true, modified: 1 },
    ])
    const second = zip([
      { path: 'scripts/run.sh', content: 'echo ok\n', executable: true, modified: 9 },
      { path: 'SKILL.md', content: '# Exec\n', modified: 9 },
    ])
    const chmodOnly = zip([
      { path: 'SKILL.md', content: '# Exec\n' },
      { path: 'scripts/run.sh', content: 'echo ok\n' },
    ])
    const a = await uploadCard(AUTHOR, first)
    const b = await uploadCard(AUTHOR, second)
    const c = await uploadCard(AUTHOR, chmodOnly)
    expect(a.body.sha256).not.toBe(b.body.sha256)
    expect(a.body.contentHash).toBe(b.body.contentHash)
    expect(a.body.executablePaths).toEqual(['scripts/run.sh'])
    expect(c.body.contentHash).toBe(a.body.contentHash)
    expect(c.body.executablePaths).toEqual([])
  })

  it('creates entries idempotently by client id and by migration key', async () => {
    const card = await uploadCard(AUTHOR, skillZip('idempotent'))
    const id = randomUUID()
    const payload = { id, name: 'idem', profile, source: { kind: 'card', cardSha256: card.body.sha256 } }
    expect((await createEntry(AUTHOR, payload)).statusCode).toBe(201)
    const replay = await createEntry(AUTHOR, payload)
    expect(replay.statusCode).toBe(200)
    expect(replay.body.id).toBe(id)
    const different = await createEntry(AUTHOR, { ...payload, name: 'idem-other' })
    expect(different.statusCode).toBe(409)
    expect(different.body.entry).toMatchObject({ id, name: 'idem' })
    expect((await createEntry(MEMBER, payload)).statusCode).toBe(409)

    const legacy = await legacySkill(AUTHOR, 'migrated', skillZip('migrated'))
    const migrationKey = `authored:${legacy.skillId}`
    const [left, right] = await Promise.all([
      createEntry(AUTHOR, { id: randomUUID(), name: 'migrated', profile, source: { kind: 'authored', skillId: legacy.skillId }, migrationKey }),
      createEntry(AUTHOR, { id: randomUUID(), name: 'migrated', profile, source: { kind: 'authored', skillId: legacy.skillId }, migrationKey }),
    ])
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 201])
    expect(left.body.id).toBe(right.body.id)
    expect(await prisma.libraryEntry.count({ where: { userId: AUTHOR, migrationKey } })).toBe(1)
    const version = await prisma.skillVersion.findUniqueOrThrow({ where: { id: legacy.versionId } })
    expect(version.cardSha256).toBe(sha256(skillZip('migrated')))
  })

  it('requires and enforces baseRevision for every entry mutation', async () => {
    const card = await uploadCard(AUTHOR, skillZip('revision'))
    const id = randomUUID()
    await createEntry(AUTHOR, { id, name: 'revision', profile, source: { kind: 'card', cardSha256: card.body.sha256 } })
    const missing = await app.inject({ method: 'PUT', url: `/api/library/${id}`, headers: as(AUTHOR), payload: { name: 'renamed' } })
    expect(missing.statusCode).toBe(428)
    const ok = await app.inject({ method: 'PUT', url: `/api/library/${id}`, headers: as(AUTHOR), payload: { baseRevision: 1, name: 'renamed' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ revision: 2, name: 'renamed' })
    const stale = await app.inject({ method: 'PUT', url: `/api/library/${id}`, headers: as(AUTHOR), payload: { baseRevision: 1, name: 'lost' } })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().entry).toMatchObject({ revision: 2, name: 'renamed' })
    expect((await app.inject({ method: 'PUT', url: `/api/library/${id}`, headers: as(MEMBER), payload: { baseRevision: 2 } })).statusCode).toBe(404)

    const deleted = await app.inject({ method: 'DELETE', url: `/api/library/${id}?baseRevision=2`, headers: as(AUTHOR) })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({ id, revision: 3 })
    const list = await app.inject({ method: 'GET', url: '/api/library', headers: as(AUTHOR) })
    expect(list.json().entries).toEqual([expect.objectContaining({ id, revision: 3, deletedAt: expect.any(String) })])
    const restored = await app.inject({ method: 'POST', url: `/api/library/${id}/restore`, headers: as(AUTHOR), payload: { baseRevision: 3 } })
    expect(restored.statusCode).toBe(200)
    expect(restored.json()).toMatchObject({ revision: 4, deletedAt: null })
  })

  it('keeps Marketplace content downloadable after the listing is withdrawn', async () => {
    const data = skillZip('market')
    const legacy = await legacySkill(AUTHOR, 'market', data)
    await listSkill(legacy.skillId, legacy.versionId)
    const added = await createEntry(MEMBER, {
      id: randomUUID(), name: 'market', profile, source: { kind: 'marketplace', skillId: legacy.skillId },
      migrationKey: `marketplace:${legacy.skillId}`,
    })
    expect(added.statusCode).toBe(201)
    expect(added.body).toMatchObject({ sourceKind: 'marketplace', sourceVersionId: legacy.versionId })
    const addPayload = {
      id: added.body.id, name: 'market', profile, source: { kind: 'marketplace', skillId: legacy.skillId },
      migrationKey: `marketplace:${legacy.skillId}`,
    }

    await prisma.marketplaceListing.update({ where: { skillId: legacy.skillId }, data: { withdrawnAt: new Date() } })
    await prisma.skill.update({ where: { id: legacy.skillId }, data: { deletedAt: new Date() } })
    const download = await app.inject({ method: 'GET', url: `/api/cards/${sha256(data)}`, headers: as(MEMBER) })
    expect(download.statusCode).toBe(200)
    expect(download.rawPayload.equals(data)).toBe(true)
    const late = await createEntry(STRANGER, {
      id: randomUUID(), name: 'market', profile, source: { kind: 'marketplace', skillId: legacy.skillId },
    })
    expect(late.statusCode).toBe(403)

    // A retry after a lost response still finds its entry once the source is gone.
    const replay = await createEntry(MEMBER, addPayload)
    expect(replay.statusCode).toBe(200)
    expect(replay.body.id).toBe(added.body.id)

    const authorAsset = await app.inject({ method: 'POST', url: `/api/library/${added.body.id}/author-asset`, headers: as(MEMBER), payload: {} })
    expect(authorAsset.statusCode).toBe(409)
    // Relabelling the same content as a local card does not make it the member's own.
    const relabelled = randomUUID()
    expect((await createEntry(MEMBER, {
      id: relabelled, name: 'market-copy', profile, source: { kind: 'card', cardSha256: sha256(data) },
    })).statusCode).toBe(201)
    expect((await app.inject({ method: 'POST', url: `/api/library/${relabelled}/author-asset`, headers: as(MEMBER), payload: {} })).statusCode).toBe(409)
  })

  it('keeps team content after the share is revoked and serializes grant with revocation', async () => {
    const data = skillZip('team')
    const legacy = await legacySkill(AUTHOR, 'team-skill', data)
    await prisma.skillTeamShare.create({ data: { skillId: legacy.skillId, teamId: TEAM_ID, sharedById: AUTHOR } })
    expect((await createEntry(STRANGER, {
      id: randomUUID(), name: 'team-skill', profile, source: { kind: 'team', skillId: legacy.skillId, teamId: TEAM_ID },
    })).statusCode).toBe(403)

    const { lockSkillTeamMutation } = await import('../lib/mutation-lock.js')
    const [added] = await Promise.all([
      createEntry(MEMBER, {
        id: randomUUID(), name: 'team-skill', profile, source: { kind: 'team', skillId: legacy.skillId, teamId: TEAM_ID },
      }),
      prisma.$transaction(async (transaction) => {
        await lockSkillTeamMutation(transaction, legacy.skillId, TEAM_ID)
        await transaction.skillTeamShare.deleteMany({ where: { skillId: legacy.skillId, teamId: TEAM_ID } })
      }),
    ])
    const grants = await prisma.cardGrant.count({ where: { userId: MEMBER, cardSha256: sha256(data) } })
    if (added.statusCode === 201) {
      expect(grants).toBe(1)
      const download = await app.inject({ method: 'GET', url: `/api/cards/${sha256(data)}`, headers: as(MEMBER) })
      expect(download.statusCode).toBe(200)
    } else {
      expect(added.statusCode).toBe(403)
      expect(grants).toBe(0)
    }
  })

  it('enforces storage, active entry and total record limits', async () => {
    const shared = skillZip('charged-to-author')
    expect((await uploadCard(AUTHOR, shared)).statusCode).toBe(201)
    mockConfig.SKILL_MAX_STORAGE_BYTES_PER_USER = skillZip('quota').length + 10
    expect((await uploadCard(MEMBER, skillZip('quota'))).statusCode).toBe(201)
    const quotaEntry = randomUUID()
    await createEntry(MEMBER, { id: quotaEntry, name: 'quota', profile, source: { kind: 'card', cardSha256: sha256(skillZip('quota')) } })
    expect((await uploadCard(MEMBER, skillZip('quota-two'))).statusCode).toBe(413)
    // Referencing someone else's existing card is not charged.
    expect((await uploadCard(MEMBER, shared)).statusCode).toBe(200)
    // Uploads nothing of the member references stop counting, so a superseded revision frees space.
    await prisma.libraryEntry.delete({ where: { id: quotaEntry } })
    // A fresh unreferenced upload still counts, so uploading first cannot bypass the quota.
    expect((await uploadCard(MEMBER, skillZip('quota-two'))).statusCode).toBe(413)
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await prisma.skillCard.update({ where: { sha256: sha256(skillZip('quota')) }, data: { createdAt: dayAgo } })
    expect((await uploadCard(MEMBER, skillZip('quota-two'))).statusCode).toBe(201)
    // Re-referencing the aged-out upload must fit the quota again.
    await prisma.skillCard.update({ where: { sha256: sha256(skillZip('quota-two')) }, data: { createdAt: dayAgo } })
    expect((await createEntry(MEMBER, {
      id: randomUUID(), name: 'quota-two', profile, source: { kind: 'card', cardSha256: sha256(skillZip('quota-two')) },
    })).statusCode).toBe(201)
    expect((await createEntry(MEMBER, {
      id: randomUUID(), name: 'quota-back', profile, source: { kind: 'card', cardSha256: sha256(skillZip('quota')) },
    })).statusCode).toBe(413)
    await prisma.libraryEntry.deleteMany({ where: { userId: MEMBER } })

    mockConfig.SKILL_MAX_STORAGE_BYTES_PER_USER = 250 * 1024 * 1024
    mockConfig.SKILL_MAX_PER_USER = 1
    const card = await uploadCard(MEMBER, skillZip('limit'))
    const first = randomUUID()
    expect((await createEntry(MEMBER, { id: first, name: 'one', profile, source: { kind: 'card', cardSha256: card.body.sha256 } })).statusCode).toBe(201)
    expect((await createEntry(MEMBER, { id: randomUUID(), name: 'two', profile, source: { kind: 'card', cardSha256: card.body.sha256 } })).statusCode).toBe(409)
    await app.inject({ method: 'DELETE', url: `/api/library/${first}?baseRevision=1`, headers: as(MEMBER) })
    const second = randomUUID()
    expect((await createEntry(MEMBER, { id: second, name: 'two', profile, source: { kind: 'card', cardSha256: card.body.sha256 } })).statusCode).toBe(201)
    expect((await app.inject({ method: 'POST', url: `/api/library/${first}/restore`, headers: as(MEMBER), payload: { baseRevision: 2 } })).statusCode).toBe(409)
  })

  it('publishes an entry as an author asset exactly once and serves it through the legacy package route', async () => {
    const data = skillZip('publish')
    const card = await uploadCard(AUTHOR, data)
    const id = randomUUID()
    await createEntry(AUTHOR, { id, name: 'publish-me', profile, source: { kind: 'card', cardSha256: card.body.sha256 } })
    const first = await app.inject({ method: 'POST', url: `/api/library/${id}/author-asset`, headers: as(AUTHOR), payload: {} })
    expect(first.statusCode).toBe(201)
    const skillId = first.json().skill.id as string
    expect(first.json().entry).toMatchObject({ authorSkillId: skillId, revision: 2 })
    const again = await app.inject({ method: 'POST', url: `/api/library/${id}/author-asset`, headers: as(AUTHOR), payload: {} })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ created: false, skill: { id: skillId } })
    expect(await prisma.skill.count({ where: { authorId: AUTHOR, name: 'publish-me' } })).toBe(1)

    const download = await app.inject({ method: 'GET', url: `/api/skills/${skillId}/package`, headers: as(AUTHOR) })
    expect(download.statusCode).toBe(200)
    expect(download.rawPayload.equals(data)).toBe(true)
  })

  it('refuses damaged card files and falls back to the database copy on legacy routes', async () => {
    const data = skillZip('damaged')
    const card = await uploadCard(AUTHOR, data)
    const id = randomUUID()
    await createEntry(AUTHOR, { id, name: 'damaged', profile, source: { kind: 'card', cardSha256: card.body.sha256 } })
    const published = await app.inject({ method: 'POST', url: `/api/library/${id}/author-asset`, headers: as(AUTHOR), payload: {} })
    const hash = sha256(data)
    writeFileSync(join(mockConfig.SKILL_CARD_STORAGE_DIR, hash.slice(0, 2), `${hash}.zip`), 'tampered')

    expect((await app.inject({ method: 'GET', url: `/api/cards/${hash}`, headers: as(AUTHOR) })).statusCode).toBe(500)
    const legacy = await app.inject({ method: 'GET', url: `/api/skills/${published.json().skill.id}/package`, headers: as(AUTHOR) })
    expect(legacy.statusCode).toBe(200)
    expect(legacy.rawPayload.equals(data)).toBe(true)
  })
  it('backfills legacy versions into cards idempotently and verifies them for restores', async () => {
    const { backfillCards, cardCoverage, parseCardOperation, verifyCards } = await import('../ops/skill-cards.js')
    expect(() => parseCardOperation(['verify', '--apply'])).toThrow()
    const data = skillZip('backfill')
    const legacy = await legacySkill(AUTHOR, 'backfill', data)
    const mismatchData = skillZip('mismatch')
    const mismatch = await prisma.skill.create({
      data: {
        name: 'mismatch', displayName: 'mismatch', authorId: AUTHOR, currentVersion: 'v1.0',
        versions: { create: { version: 'v1.0', packageData: mismatchData, packageSha256: 'f'.repeat(64), packageSize: mismatchData.length } },
      },
      include: { versions: true },
    })
    const before = await cardCoverage()

    const dryRun = await backfillCards(parseCardOperation(['backfill']))
    expect(dryRun.carded).toBe(0)
    expect((await prisma.skillVersion.findUniqueOrThrow({ where: { id: legacy.versionId } })).cardSha256).toBeNull()

    const applied = await backfillCards(parseCardOperation(['backfill', '--apply']))
    expect(applied.mismatched).toContain(mismatch.versions[0]?.id)
    const version = await prisma.skillVersion.findUniqueOrThrow({ where: { id: legacy.versionId } })
    expect(version.cardSha256).toBe(sha256(data))
    expect(version.packageData && Buffer.from(version.packageData).equals(data)).toBe(true)
    expect(await prisma.cardGrant.count({ where: { userId: AUTHOR, cardSha256: sha256(data), reason: 'authored' } })).toBe(1)
    await backfillCards(parseCardOperation(['backfill', '--apply']))
    expect(await prisma.skillCard.count({ where: { sha256: sha256(data) } })).toBe(1)
    expect((await cardCoverage()).versionPackageDigest).toBe(before.versionPackageDigest)

    const verified = await verifyCards()
    expect(verified.damaged).not.toContain(sha256(data))
    expect(verified.dangling).not.toContain(sha256(data))
    writeFileSync(join(mockConfig.SKILL_CARD_STORAGE_DIR, sha256(data).slice(0, 2), `${sha256(data)}.zip`), 'lost')
    expect((await verifyCards()).damaged).toContain(sha256(data))
  })
})
