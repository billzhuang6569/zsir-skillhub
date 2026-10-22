import { createHash } from 'node:crypto'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classicAvatarStyle, canonicalJson, contentSha256 } from './avatar-style-catalog.js'
const database = vi.hoisted(() => ({ $transaction: vi.fn() }))
vi.mock('../db.js', () => ({ db: database }))
vi.mock('../config.js', () => ({ config: { SKILLHUB_PROFILE: 'yitan-official', PUBLIC_BASE_URL: 'https://example.invalid' } }))
import { assertAvatarReadModeAvailable, inspectAvatarModel, readAvatarImageHash, verifyAvatarModel, type AvatarModelSnapshot } from './avatar-model-verification.js'
import { config } from '../config.js'

function fixture(): AvatarModelSnapshot {
  const now = new Date('2026-10-18T00:00:00Z'), hash = createHash('sha256').update('image').digest('hex')
  const anchor = { id: 'anchor', ownerId: 'owner', localSkillId: 'local', skillId: null, currentJobId: 'job',
    input: { name: 'Example', description: 'Example', scenarios: [] }, inputFingerprint: 'input', promptVersion: 'v1', prompt: 'private prompt',
    status: 'ready', requestId: 'request', submittedAt: now, imageUrl: null, imageData: null, imageSha256: hash,
    assetId: 'asset', url: 'https://picem-media.whatonearth.work/test.jpg', errorCode: null, attempts: 0, nextAttemptAt: now,
    leaseToken: null, leaseUntil: null, source: 'generated', customAssetId: null, customUrl: null, customUpdatedAt: null,
    queuedAt: now, createdAt: now, updatedAt: now }
  const job = { ...anchor, id: 'job', logicalSkillId: anchor.id, generationRevision: 1, selectionRevision: 1,
    styleId: 'classic', styleVersion: 1, path: 'meta', promptSha256: createHash('sha256').update(anchor.prompt).digest('hex'),
    falModel: classicAvatarStyle.fal.meta.model, falParameters: classicAvatarStyle.fal.meta.parameters, idempotencyKey: 'avatar:anchor:1' }
  const variant = { id: 'variant', ownerId: anchor.ownerId, logicalSkillId: anchor.id, generationRevision: 1,
    styleId: 'classic', styleVersion: 1, inputFingerprint: anchor.inputFingerprint, path: 'meta', promptVersion: 'v1',
    prompt: anchor.prompt, promptSha256: job.promptSha256, assetId: anchor.assetId, url: anchor.url, imageSha256: hash, jobId: 'job', createdAt: now }
  const selection = { ownerId: anchor.ownerId, logicalSkillId: anchor.id, source: 'generated', variantId: variant.id,
    currentJobId: job.id, revision: 1, customAssetId: null, customUrl: null, customUpdatedAt: null, createdAt: now, updatedAt: now }
  const content = canonicalJson(classicAvatarStyle)
  return { anchors: [anchor], jobs: [job], variants: [variant], selections: [selection],
    aliases: [{ ownerId: 'owner', aliasLocalId: 'device', avatarId: anchor.id, createdAt: now }],
    attempts: [{ id: 'attempt', avatarId: anchor.id, jobId: job.id, day: now, kind: 'create', createdAt: now, releasedAt: null }],
    listings: [], skills: [], styles: [{ styleId: 'classic', styleVersion: 1, content, contentSha256: contentSha256(content), source: 'repository', createdAt: now }] }
}

afterEach(() => vi.unstubAllGlobals())
describe('avatar model verification', () => {
  it('variants permits active jobs in distinct styles but rejects duplicate active versions of one style at startup', async () => {
    const data = fixture()
    const style = { ...classicAvatarStyle, styleId: 'other-style' }
    const content = canonicalJson(style)
    data.styles.push({ ...data.styles[0], styleId: style.styleId, content, contentSha256: contentSha256(content) })
    data.jobs.push({ ...data.jobs[0], id: 'active-a', generationRevision: 2, status: 'awaiting', queuedAt: null,
      requestId: 'request-a', idempotencyKey: 'avatar:anchor:2' })
    data.jobs.push({ ...data.jobs[1], id: 'active-b', generationRevision: 3, styleId: style.styleId,
      requestId: 'request-b', idempotencyKey: 'avatar:anchor:3' })
    expect(inspectAvatarModel(data, 'variants').differences).toEqual([])
    database.$transaction.mockResolvedValue(data)
    const previous = config.SKILL_AVATAR_MODEL_READS
    config.SKILL_AVATAR_MODEL_READS = 'variants'
    try {
      await expect(assertAvatarReadModeAvailable('variants')).resolves.toBeUndefined()
      data.jobs[2].styleId = 'classic'
      expect(inspectAvatarModel(data, 'variants').differences).toContainEqual(expect.objectContaining({ category: 'activeUnique' }))
      await expect(assertAvatarReadModeAvailable('variants')).rejects.toThrow('Avatar model verification failed')
    } finally { config.SKILL_AVATAR_MODEL_READS = previous }
  })
  it('accepts resolved migration styles in legacy mode without relaxing ordinary generated jobs', () => {
    const data = fixture()
    const style = { ...classicAvatarStyle, styleId: 'imported-style' }
    const content = canonicalJson(style)
    data.styles.push({ styleId: style.styleId, styleVersion: 1, content, contentSha256: contentSha256(content), source: 'repository', createdAt: data.styles[0].createdAt })
    data.jobs[0].styleId = style.styleId; data.variants[0].styleId = style.styleId
    expect(inspectAvatarModel(data, 'legacy').differences).toContainEqual(expect.objectContaining({ category: 'jobStyle' }))
    data.jobs[0].idempotencyKey = 'migration:anchor:1'
    expect(inspectAvatarModel(data, 'legacy').differences).toEqual([])
    data.jobs[0].falModel = 'unresolved/model'
    expect(inspectAvatarModel(data, 'legacy').differences).toContainEqual(expect.objectContaining({ category: 'jobStyle' }))
  })
  it('compares old/new display and prints only counts and digests', async () => {
    database.$transaction.mockResolvedValue(fixture())
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const result = await verifyAvatarModel()
    expect(result.counts.mismatches).toBe(0)
    expect(result.digests.legacyDisplay).toBe(result.digests.modelDisplay)
    expect(Object.keys(result)).toEqual(['counts', 'digests'])
    expect(JSON.stringify(result)).not.toMatch(/private prompt|https:|"owner"|"request"/)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([
    ['coverage', (s: AvatarModelSnapshot): void => { s.jobs = [] }],
    ['owner', (s: AvatarModelSnapshot): void => { s.selections[0].ownerId = 'foreign' }],
    ['alias', (s: AvatarModelSnapshot): void => { s.aliases[0].ownerId = 'foreign' }],
    ['mirror', (s: AvatarModelSnapshot): void => { s.jobs[0].attempts++ }],
    ['hash', (s: AvatarModelSnapshot): void => { s.jobs[0].promptSha256 = '0'.repeat(64) }],
    ['url', (s: AvatarModelSnapshot): void => { s.variants[0].url += '/changed' }],
    ['ledger', (s: AvatarModelSnapshot): void => { s.attempts[0].jobId = null }],
  ])('detects injected %s mismatch', (_name, mutate) => {
    const data = fixture(); mutate(data)
    expect(inspectAvatarModel(data).summary.counts.mismatches).toBeGreaterThan(0)
  })
  it('reads each permanent URL once and fails stored hash mismatches', async () => {
    database.$transaction.mockResolvedValue(fixture())
    const fetcher = vi.fn().mockImplementation(async () => new Response('image', { headers: { 'content-type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetcher)
    expect((await verifyAvatarModel({ images: true })).counts).toMatchObject({ mismatches: 0, images: 1 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error' })
    fetcher.mockImplementation(async () => new Response('changed', { headers: { 'content-type': 'image/jpeg' } }))
    expect((await verifyAvatarModel({ images: true })).counts['mismatch.permanentImageHash']).toBe(1)
  })
  it('rejects untrusted URLs before fetch and bounds response bytes', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await expect(readAvatarImageHash('http://127.0.0.1/secret')).rejects.toThrow()
    await expect(readAvatarImageHash('https://picem-media.whatonearth.work/x?token=secret')).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    fetcher.mockResolvedValue(new Response(new Uint8Array(10 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }))
    await expect(readAvatarImageHash('https://picem-media.whatonearth.work/x')).rejects.toThrow('AVATAR_IMAGE_TOO_LARGE')
  })
  it('writes details only to a newly created protected report', async () => {
    const data = fixture(); data.jobs[0].url = 'changed'; database.$transaction.mockResolvedValue(data)
    const directory = await mkdtemp(join(tmpdir(), 'avatar-report-')), path = join(directory, 'report.json')
    try {
      await verifyAvatarModel({ reportPath: path })
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(path, 'utf8')).differences).toContainEqual({ category: 'mirror', anchorId: 'anchor', ownerId: 'owner', field: 'url' })
      await expect(verifyAvatarModel({ reportPath: path })).rejects.toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('legacy skips verification; variants checks only the database and rejects mismatches before startup continues', async () => {
    database.$transaction.mockClear()
    await assertAvatarReadModeAvailable('legacy')
    expect(database.$transaction).not.toHaveBeenCalled()
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const data = fixture(); data.jobs[0].url = 'changed'
    database.$transaction.mockResolvedValue(data)
    const listen = vi.fn(), startWorker = vi.fn(), submit = vi.fn()
    await expect((async (): Promise<void> => {
      await assertAvatarReadModeAvailable('variants')
      listen(); startWorker(); submit()
    })()).rejects.toThrow('Avatar model verification failed')
    expect(listen).not.toHaveBeenCalled(); expect(startWorker).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    database.$transaction.mockResolvedValue(fixture())
    await assertAvatarReadModeAvailable('variants')
  })
  it('variants accepts frozen Skill columns and historical fallback but rejects incorrect selected results', () => {
    const data = fixture()
    data.anchors[0].skillId = 'skill'
    data.skills.push({ id: 'skill', authorId: 'owner', deletedAt: null, avatarUrl: 'frozen', avatarStatus: 'failed' })
    data.selections[0].revision = 2
    expect(inspectAvatarModel(data, 'variants').summary.counts.mismatches).toBe(0)
    expect(inspectAvatarModel(data, 'legacy').summary.counts.mismatches).toBeGreaterThan(0)
    data.selections[0].revision = 1
    data.selections[0].variantId = null
    expect(inspectAvatarModel(data, 'variants').summary.counts['mismatch.readyCoverage']).toBe(1)
  })
})
