import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import sensible from '@fastify/sensible'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  skillAvatar: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() }, skillAvatarAlias: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
  skill: { updateMany: vi.fn() }, ensure: vi.fn(), upload: vi.fn(), restore: vi.fn(), retry: vi.fn(),
}))
vi.mock('../db.js', () => ({ db: mock }))
vi.mock('../lib/skill-avatars.js', async (original) => ({
  ...await original<typeof import('../lib/skill-avatars.js')>(), ensureSkillAvatar: mock.ensure,
  uploadCustomAvatar: mock.upload, restoreGeneratedAvatar: mock.restore, retryFailedAvatar: mock.retry,
}))
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.headers.authorization) { await reply.code(401).send({ error: 'Unauthorized' }); return }
    request.user = { id: 'owner', email: 'owner@example.invalid', displayName: 'Owner', marketplaceRole: 'user' }
  },
}))
import { skillAvatarRoutes } from './skill-avatars.js'
import { config } from '../config.js'

let app: FastifyInstance
const originalMode = config.SKILL_AVATAR_MODEL_READS
const originalProfile = config.SKILLHUB_PROFILE
const headers = { authorization: 'Bearer test-owner' }
beforeEach(async () => {
  vi.clearAllMocks()
  app = Fastify()
  await app.register(sensible)
  await app.register(skillAvatarRoutes, { prefix: '/api/skill-avatars' })
  await app.ready()
})
afterEach(async () => {
  await app.close()
  config.SKILL_AVATAR_MODEL_READS = originalMode
  config.SKILLHUB_PROFILE = originalProfile
})

it('protects all avatar operations and queries only the current account', async () => {
  const unauthorized = await app.inject({ url: '/api/skill-avatars/local' })
  expect(unauthorized.statusCode).toBe(401)
  expect(mock.skillAvatar.findMany).not.toHaveBeenCalled()
  mock.skillAvatar.findMany.mockResolvedValue([{ localSkillId: 'local-id', skillId: null, status: 'awaiting', url: null }])
  const response = await app.inject({ url: '/api/skill-avatars/local', headers })
  expect(response.headers['cache-control']).toBe('no-store, private')
  expect(mock.skillAvatar.findMany.mock.calls[0][0].where.ownerId).toBe('owner')
  // Local tasks, plus the owner's tasks for their own live cloud Skills (cloud-only Skills read their source here).
  expect(mock.skillAvatar.findMany.mock.calls[0][0].where.OR).toEqual([
    { localSkillId: { not: null } }, { skillId: { not: null }, skill: { is: { authorId: 'owner', deletedAt: null } } },
  ])
  expect(response.json().items).toEqual([{ localSkillId: 'local-id', skillId: null, aliases: [], avatarStatus: 'pending', avatarUrl: null, avatarSource: 'generated' }])
})

it('accepts only the local identity and minimal introduction, never a Skill package', async () => {
  const payload = { localSkillId: 'local-id', name: 'Research', description: 'Organize sources', scenarios: [] }
  mock.ensure.mockResolvedValue({ skillId: null, status: 'queued', url: null })
  const valid = await app.inject({ method: 'POST', url: '/api/skill-avatars/local', headers, payload })
  expect(valid.statusCode).toBe(200)
  expect(mock.ensure).toHaveBeenCalledWith({ ownerId: 'owner', localSkillId: 'local-id', skillId: undefined,
    input: { name: 'Research', description: 'Organize sources', scenarios: [] } })
  const invalid = await app.inject({ method: 'POST', url: '/api/skill-avatars/local', headers,
    payload: { ...payload, skillMd: 'private package content' } })
  expect(invalid.statusCode).toBe(400)
  expect(mock.ensure).toHaveBeenCalledTimes(1)
})

it('resumes a failed transfer and refuses to retry an unknown paid submission', async () => {
  mock.skillAvatar.findUnique.mockResolvedValue({ id: 'job', ownerId: 'owner', skillId: null, status: 'needs_review' })
  const uncertain = await app.inject({ method: 'POST', url: '/api/skill-avatars/local/local-id/retry', headers })
  expect(uncertain.statusCode).toBe(409)
  expect(mock.skillAvatar.updateMany).not.toHaveBeenCalled()
  mock.skillAvatar.findUnique.mockResolvedValue({ id: 'job', ownerId: 'owner', skillId: null, status: 'failed', imageData: Buffer.from('saved'), requestId: 'accepted' })
  mock.retry.mockResolvedValue({ transitioned: true, avatar: { status: 'transferring', url: null } })
  const retry = await app.inject({ method: 'POST', url: '/api/skill-avatars/local/local-id/retry', headers })
  expect(retry.statusCode).toBe(200)
  expect(mock.skillAvatar.findUnique.mock.calls.at(-1)?.[0].where.ownerId_localSkillId.ownerId).toBe('owner')
  expect(mock.skillAvatarAlias.findUnique.mock.calls.at(-1)?.[0].where.ownerId_aliasLocalId).toEqual({ ownerId: 'owner', aliasLocalId: 'local-id' })
  // The transition (transfer / poll are free, only a redraw reserves quota) lives in retryFailedAvatar; see skill-avatars-custom.test.ts.
  expect(mock.retry).toHaveBeenCalledWith('owner', 'job')
  expect(retry.json()).toEqual({ avatarUrl: null, avatarStatus: 'pending', avatarSource: 'generated' })
  // A duplicate request that did not move the task gets the current state.
  mock.retry.mockResolvedValue({ transitioned: false, avatar: { status: 'failed', url: null } })
  const duplicate = await app.inject({ method: 'POST', url: '/api/skill-avatars/local/local-id/retry', headers })
  expect(duplicate.json()).toEqual({ avatarUrl: null, avatarStatus: 'failed', avatarSource: 'generated' })
  // The daily quota is a labelled 429 with Retry-After, distinct from the retry rate limit.
  const { AvatarError } = await import('../lib/skill-avatars.js')
  mock.retry.mockRejectedValueOnce(new AvatarError(429, '头像生成额度已达上限，请稍后重试', 'AVATAR_DAILY_QUOTA', 120))
  const quota = await app.inject({ method: 'POST', url: '/api/skill-avatars/local/local-id/retry', headers })
  expect(quota.statusCode).toBe(429)
  expect(quota.json().code).toBe('AVATAR_DAILY_QUOTA')
  expect(quota.headers['retry-after']).toBe('120')
})

it('keeps upstream diagnostics and prompts out of errors', async () => {
  mock.ensure.mockRejectedValue(new Error('private prompt and provider credentials'))
  const response = await app.inject({ method: 'POST', url: '/api/skill-avatars/skills/11111111-1111-4111-8111-111111111111', headers })
  expect(response.statusCode).toBe(503)
  expect(response.body).not.toContain('private prompt')
})

it('labels each avatar rejection so clients can back off by cause', async () => {
  const { AvatarError, secondsUntilNextUtcMidnight } = await import('../lib/skill-avatars.js')
  const payload = { localSkillId: 'local-id', name: 'Research', description: 'Organize sources', scenarios: [] }
  mock.ensure.mockRejectedValueOnce(new AvatarError(429, '头像生成额度已达上限，请稍后重试', 'AVATAR_DAILY_QUOTA', 3600))
  const quota = await app.inject({ method: 'POST', url: '/api/skill-avatars/local', headers, payload })
  expect(quota.statusCode).toBe(429)
  expect(quota.headers['retry-after']).toBe('3600')
  expect(quota.json()).toEqual({ error: '头像生成额度已达上限，请稍后重试', code: 'AVATAR_DAILY_QUOTA' })

  mock.ensure.mockRejectedValueOnce(new AvatarError(503, '头像生成暂未开启', 'AVATAR_GENERATION_DISABLED'))
  const disabled = await app.inject({ method: 'POST', url: '/api/skill-avatars/local', headers, payload })
  expect(disabled.statusCode).toBe(503)
  expect(disabled.headers['retry-after']).toBeUndefined()
  expect(disabled.json().code).toBe('AVATAR_GENERATION_DISABLED')

  mock.ensure.mockResolvedValue({ skillId: null, status: 'queued', url: null })
  for (let attempt = 2; attempt < 60; attempt += 1) {
    await app.inject({ method: 'POST', url: '/api/skill-avatars/local', headers, payload })
  }
  const limited = await app.inject({ method: 'POST', url: '/api/skill-avatars/local', headers, payload })
  expect(limited.statusCode).toBe(429)
  expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
  expect(limited.json().code).toBe('AVATAR_RATE_LIMITED')

  expect(secondsUntilNextUtcMidnight(new Date('2026-10-04T23:59:30.000Z'))).toBe(30)
  expect(secondsUntilNextUtcMidnight(new Date('2026-10-04T00:00:00.000Z'))).toBe(86_400)
})

it('retry resolves an old alias to the same canonical task, keeps state guards, and never crosses accounts', async () => {
  const canonical = { id: 'job', ownerId: 'owner', localSkillId: 'entry-id', skillId: null, status: 'failed', requestId: 'accepted' }
  // Canonical id hits the task directly; the old device id hits it through the alias table.
  mock.skillAvatar.findUnique.mockImplementation(async (args: { where: { ownerId_localSkillId: { ownerId: string; localSkillId: string } } }) =>
    args.where.ownerId_localSkillId.ownerId === 'owner' && args.where.ownerId_localSkillId.localSkillId === 'entry-id' ? canonical : null)
  mock.skillAvatarAlias.findUnique.mockImplementation(async (args: { where: { ownerId_aliasLocalId: { ownerId: string; aliasLocalId: string } } }) =>
    args.where.ownerId_aliasLocalId.ownerId === 'owner' && args.where.ownerId_aliasLocalId.aliasLocalId === 'device-id' ? { avatarId: 'job', avatar: canonical } : null)
  mock.retry.mockResolvedValue({ transitioned: true, avatar: { ...canonical, status: 'awaiting' } })
  for (const id of ['entry-id', 'device-id']) {
    const response = await app.inject({ method: 'POST', url: `/api/skill-avatars/local/${id}/retry`, headers })
    expect(response.statusCode, id).toBe(200)
    expect(mock.retry).toHaveBeenLastCalledWith('owner', 'job')
  }
  expect(mock.retry).toHaveBeenCalledTimes(2)
  // An uncertain paid submission behind an alias is still refused.
  const uncertain = { ...canonical, status: 'needs_review' }
  mock.skillAvatarAlias.findUnique.mockResolvedValue({ avatarId: 'job', avatar: uncertain })
  expect((await app.inject({ method: 'POST', url: '/api/skill-avatars/local/device-id/retry', headers })).statusCode).toBe(409)
  // A retired task never resolves; another account's alias is never consulted for this owner.
  mock.skillAvatarAlias.findUnique.mockResolvedValue({ avatarId: 'job', avatar: { ...canonical, status: 'superseded' } })
  mock.skillAvatar.findUnique.mockResolvedValue(null)
  expect((await app.inject({ method: 'POST', url: '/api/skill-avatars/local/device-id/retry', headers })).statusCode).toBe(404)
  mock.skillAvatarAlias.findUnique.mockResolvedValue({ avatarId: 'job', avatar: { ...canonical, ownerId: 'someone-else' } })
  expect((await app.inject({ method: 'POST', url: '/api/skill-avatars/local/device-id/retry', headers })).statusCode).toBe(404)
  for (const call of mock.skillAvatarAlias.findUnique.mock.calls) expect(call[0].where.ownerId_aliasLocalId.ownerId).toBe('owner')
  expect(mock.skillAvatar.create).toBeUndefined()
})

const CLOUD = '11111111-1111-4111-8111-111111111111'
const image = { mimeType: 'image/webp', dataBase64: 'UklGRg==' }
const customRow = { localSkillId: 'local-id', skillId: null, status: 'cancelled', url: null, source: 'custom', customUrl: 'https://picem-media.whatonearth.work/c.webp' }

it('custom upload takes the same identity and introduction as registration, plus one image', async () => {
  const unauthorized = await app.inject({ method: 'POST', url: '/api/skill-avatars/local/custom', payload: {} })
  expect(unauthorized.statusCode).toBe(401)
  mock.upload.mockResolvedValue(customRow)
  const payload = { localSkillId: 'local-id', aliasLocalIds: ['device-id'], name: 'Research', description: 'Organize sources', scenarios: [], image }
  const valid = await app.inject({ method: 'POST', url: '/api/skill-avatars/local/custom', headers, payload })
  expect(valid.statusCode).toBe(200)
  expect(valid.json()).toEqual({ localSkillId: 'local-id', skillId: null, avatarUrl: customRow.customUrl, avatarStatus: 'ready', avatarSource: 'custom' })
  expect(mock.upload).toHaveBeenCalledWith({ ownerId: 'owner', localSkillId: 'local-id', aliasLocalIds: ['device-id'], skillId: undefined,
    input: { name: 'Research', description: 'Organize sources', scenarios: [] }, image })
  for (const invalid of [
    { ...payload, image: { ...image, mimeType: 'image/gif' } },
    { ...payload, image: undefined },
    { ...payload, name: undefined },
    { ...payload, skillMd: 'private package content' },
    { ...payload, image: { ...image, dataBase64: 'A'.repeat(2_800_001) } },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/api/skill-avatars/local/custom', headers, payload: invalid })
    expect(response.statusCode).toBe(400)
  }
  expect(mock.upload).toHaveBeenCalledTimes(1)
  const cloud = await app.inject({ method: 'POST', url: `/api/skill-avatars/skills/${CLOUD}/custom`, headers, payload: { image } })
  expect(cloud.statusCode).toBe(200)
  expect(mock.upload.mock.calls.at(-1)?.[0]).toEqual({ ownerId: 'owner', skillId: CLOUD, image })
  expect((await app.inject({ method: 'POST', url: '/api/skill-avatars/skills/not-a-uuid/custom', headers, payload: { image } })).statusCode).toBe(400)
})

it('image and identity failures from the upload keep their status and code', async () => {
  const { AvatarError } = await import('../lib/skill-avatars.js')
  mock.upload.mockRejectedValueOnce(new AvatarError(400, '头像须为 256–1024 像素的正方形图片', 'AVATAR_IMAGE_DIMENSIONS'))
  const tooSmall = await app.inject({ method: 'POST', url: `/api/skill-avatars/skills/${CLOUD}/custom`, headers, payload: { image } })
  expect(tooSmall.statusCode).toBe(400)
  expect(tooSmall.json().code).toBe('AVATAR_IMAGE_DIMENSIONS')
  mock.upload.mockRejectedValueOnce(new AvatarError(404, 'Skill 不存在'))
  expect((await app.inject({ method: 'POST', url: `/api/skill-avatars/skills/${CLOUD}/custom`, headers, payload: { image } })).statusCode).toBe(404)
})

it('restoring generation maps quota and disabled generation to 429 / 503 and resolves keys for this account', async () => {
  const { AvatarError } = await import('../lib/skill-avatars.js')
  mock.restore.mockResolvedValueOnce({ localSkillId: 'entry-id', skillId: null, status: 'queued', url: null, source: 'generated', customUrl: null })
  const restored = await app.inject({ method: 'DELETE', url: '/api/skill-avatars/local/device-id/custom', headers })
  expect(restored.statusCode).toBe(200)
  expect(restored.json()).toEqual({ localSkillId: 'entry-id', skillId: null, avatarUrl: null, avatarStatus: 'pending', avatarSource: 'generated' })
  expect(mock.restore).toHaveBeenCalledWith('owner', { localSkillId: 'device-id' })
  mock.restore.mockRejectedValueOnce(new AvatarError(429, '头像生成额度已达上限，请稍后重试', 'AVATAR_DAILY_QUOTA', 120))
  const quota = await app.inject({ method: 'DELETE', url: `/api/skill-avatars/skills/${CLOUD}/custom`, headers })
  expect(quota.statusCode).toBe(429)
  expect(quota.headers['retry-after']).toBe('120')
  expect(mock.restore.mock.calls.at(-1)).toEqual(['owner', { skillId: CLOUD }])
  mock.restore.mockRejectedValueOnce(new AvatarError(503, '头像生成暂未开启', 'AVATAR_GENERATION_DISABLED'))
  expect((await app.inject({ method: 'DELETE', url: `/api/skill-avatars/skills/${CLOUD}/custom`, headers })).json().code).toBe('AVATAR_GENERATION_DISABLED')
})

it('upload and restore share a 20 per hour budget per account', async () => {
  mock.restore.mockResolvedValue({ localSkillId: 'local-id', skillId: null, status: 'ready', url: 'u', source: 'generated', customUrl: null })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    expect((await app.inject({ method: 'DELETE', url: '/api/skill-avatars/local/local-id/custom', headers })).statusCode).toBe(200)
  }
  const limited = await app.inject({ method: 'POST', url: `/api/skill-avatars/skills/${CLOUD}/custom`, headers, payload: { image } })
  expect(limited.statusCode).toBe(429)
  expect(limited.json().code).toBe('AVATAR_CUSTOM_RATE_LIMITED')
  expect(mock.upload).not.toHaveBeenCalled()
})

it('retrying generation while a custom image is shown is a 409 the client can name', async () => {
  mock.skillAvatarAlias.findUnique.mockResolvedValue(null)
  mock.skillAvatar.findUnique.mockResolvedValue({ id: 'job', ownerId: 'owner', skillId: null, status: 'failed', source: 'custom', customUrl: 'c' })
  const response = await app.inject({ method: 'POST', url: '/api/skill-avatars/local/local-id/retry', headers })
  expect(response.statusCode).toBe(409)
  expect(response.json().code).toBe('AVATAR_CUSTOM_ACTIVE')
  expect(mock.skillAvatar.updateMany).not.toHaveBeenCalled()
})

const exportDate = new Date('2026-10-20T00:00:00Z')
const exportVariants = [
  { id: 'new', styleId: 'ink', styleVersion: 2, url: '/media/new.png', imageSha256: 'a'.repeat(64), createdAt: exportDate },
  { id: 'old', styleId: 'ink', styleVersion: 1, url: '/media/old.png', imageSha256: null, createdAt: exportDate },
  { id: 'classic', styleId: 'classic', styleVersion: 1, url: 'https://media.example/classic.png', imageSha256: null, createdAt: exportDate },
]
const exportAnchor = {
  id: 'anchor', skillId: CLOUD, localSkillId: 'local-id', status: 'ready', source: 'generated', url: '/media/new.png',
  imageSha256: 'a'.repeat(64), updatedAt: exportDate, customUrl: '/media/custom.png', customUpdatedAt: exportDate,
  currentJob: { styleId: 'ink', styleVersion: 2, variant: { id: 'new' } },
  selection: { source: 'generated', variantId: 'old', customUrl: '/media/custom.png', customUpdatedAt: exportDate },
  variants: exportVariants,
}

it.each(['selfhost', 'yitan-official'] as const)('exports all ready history and current selection in %s', async profile => {
  config.SKILLHUB_PROFILE = profile
  config.SKILL_AVATAR_MODEL_READS = 'variants'
  mock.skillAvatar.findMany.mockResolvedValue([exportAnchor])
  const response = await app.inject({ url: `/api/skill-avatars/export?skillIds=${CLOUD}`, headers })
  expect(response.statusCode).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store, private')
  expect(response.json()).toEqual({ items: [{
    skillId: CLOUD, localSkillId: 'local-id', anchorId: 'anchor', selected: { kind: 'generated', variantId: 'old' },
    variants: exportVariants.map(({ id, imageSha256, ...rest }) => ({ ...rest, variantId: id, sha256: imageSha256, createdAt: exportDate.toISOString() })),
    custom: { url: '/media/custom.png', updatedAt: exportDate.toISOString() },
  }] })
  const args = mock.skillAvatar.findMany.mock.calls[0][0]
  expect(args.where).toMatchObject({ ownerId: 'owner', skillId: { in: [CLOUD] }, skill: { is: { authorId: 'owner', deletedAt: null } } })
  expect(args.select.variants.where).toEqual({ job: { status: 'ready' } })
  expect(args.select.variants.take).toBeUndefined()
  expect(JSON.stringify(args.select)).not.toMatch(/prompt|requestId|imageData/)
  expect(mock.ensure).not.toHaveBeenCalled()
})

it('exports selected custom, retained custom, display fallback and empty selections', async () => {
  config.SKILL_AVATAR_MODEL_READS = 'variants'
  for (const [selection, variants, selected] of [
    [{ ...exportAnchor.selection, source: 'custom' }, exportVariants, { kind: 'custom' }],
    [{ ...exportAnchor.selection, variantId: null }, exportVariants, { kind: 'generated', variantId: 'new' }],
    [{ ...exportAnchor.selection, variantId: null, customUrl: null }, [], null],
    [null, exportVariants, null],
  ]) {
    mock.skillAvatar.findMany.mockResolvedValue([{ ...exportAnchor, selection, variants }])
    const response = await app.inject({ url: '/api/skill-avatars/export?localSkillIds=local-id', headers })
    expect(response.statusCode).toBe(200)
    expect(response.json().items[0].selected).toEqual(selected)
  }
  expect(mock.skillAvatar.findMany.mock.calls[0][0].where).toEqual({
    ownerId: 'owner', status: { not: 'superseded' }, localSkillId: { in: ['local-id'] },
  })
})

it('omits missing and foreign IDs, including mixed requests', async () => {
  config.SKILL_AVATAR_MODEL_READS = 'variants'
  const foreign = '22222222-2222-4222-8222-222222222222'
  mock.skillAvatar.findMany.mockImplementation(async ({ where }: { where: { ownerId: string; skillId: { in: string[] }; skill: { is: { authorId: string } } } }): Promise<unknown[]> =>
    where.ownerId === 'owner' && where.skill.is.authorId === 'owner' && where.skillId.in.includes(CLOUD) ? [exportAnchor] : [])
  for (const [ids, count] of [[CLOUD, 1], [foreign, 0], [`${CLOUD},${foreign}`, 1]] as const) {
    const response = await app.inject({ url: `/api/skill-avatars/export?skillIds=${ids}`, headers })
    expect(response.statusCode).toBe(200)
    expect(response.json().items).toHaveLength(count)
  }
})

it('validates exactly one bounded ID list before querying and requires auth', async () => {
  expect((await app.inject('/api/skill-avatars/export?localSkillIds=local-id')).statusCode).toBe(401)
  for (const query of ['', '?skillIds=', '?skillIds=invalid', '?localSkillIds=', '?localSkillIds=a,,b',
    '?localSkillIds=a&skillIds=' + CLOUD, '?localSkillIds=a&extra=b',
    '?localSkillIds=a&localSkillIds=b', '?localSkillIds=' + Array(101).fill('a').join(','),
    '?skillIds=' + Array(101).fill(CLOUD).join(',')]) {
    expect((await app.inject({ url: '/api/skill-avatars/export' + query, headers })).statusCode, query).toBe(400)
  }
  expect(mock.skillAvatar.findMany).not.toHaveBeenCalled()
  mock.skillAvatar.findMany.mockResolvedValue([])
  for (const query of ['localSkillIds=' + Array(100).fill('a').join(','), 'skillIds=' + Array(100).fill(CLOUD).join(',')]) {
    expect((await app.inject({ url: '/api/skill-avatars/export?' + query, headers })).statusCode).toBe(200)
  }
})

it('legacy exports only the displayed image, with partial true and stable legacy identity', async () => {
  config.SKILL_AVATAR_MODEL_READS = 'legacy'
  for (const source of ['generated', 'custom']) {
    mock.skillAvatar.findMany.mockResolvedValue([{ ...exportAnchor, source }])
    const response = await app.inject({ url: '/api/skill-avatars/export?localSkillIds=local-id', headers })
    expect(response.json().partial).toBe(true)
    const item = response.json().items[0]
    expect(item.selected).toEqual(source === 'custom' ? { kind: 'custom' } : { kind: 'generated', variantId: 'new' })
    expect(item.variants).toHaveLength(source === 'custom' ? 0 : 1)
    expect(item.custom).toEqual(source === 'custom' ? { url: '/media/custom.png', updatedAt: exportDate.toISOString() } : null)
  }
  mock.skillAvatar.findMany.mockResolvedValue([{ ...exportAnchor, variants: [], currentJob: null, imageSha256: null }])
  const legacy = await app.inject({ url: '/api/skill-avatars/export?localSkillIds=local-id', headers })
  expect(legacy.json().items[0].variants[0]).toMatchObject({ variantId: 'anchor', styleId: 'classic', styleVersion: 1, sha256: null })
  mock.skillAvatar.findMany.mockResolvedValue([{ ...exportAnchor,
    currentJob: { styleId: 'ink', styleVersion: 1, variant: { id: 'old' } },
    variants: exportVariants.map(value => ({ ...value, url: exportAnchor.url })),
  }])
  const reused = await app.inject({ url: '/api/skill-avatars/export?localSkillIds=local-id', headers })
  expect(reused.json().items[0].variants[0]).toMatchObject({ variantId: 'old', styleId: 'ink', styleVersion: 1 })
  mock.skillAvatar.findMany.mockResolvedValue([{ ...exportAnchor, status: 'failed' }])
  expect((await app.inject({ url: '/api/skill-avatars/export?localSkillIds=local-id', headers })).json().items[0])
    .toMatchObject({ selected: null, variants: [], custom: null })
})

it('limits exports to 60 per minute, separately from writes, and resets the window', async () => {
  mock.skillAvatar.findMany.mockResolvedValue([])
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  try {
    await app.close()
    app = Fastify()
    await app.register(sensible)
    await app.register(skillAvatarRoutes, { prefix: '/api/skill-avatars' })
    for (let count = 0; count < 60; count++) {
      expect((await app.inject({ url: '/api/skill-avatars/export?localSkillIds=a', headers })).statusCode).toBe(200)
    }
    const limited = await app.inject({ url: '/api/skill-avatars/export?localSkillIds=a', headers })
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBe('60')
    expect(limited.headers['cache-control']).toBe('no-store, private')
    expect(limited.json().code).toBe('AVATAR_EXPORT_RATE_LIMITED')
    expect(mock.skillAvatar.findMany).toHaveBeenCalledTimes(60)
    mock.ensure.mockResolvedValue({ skillId: null, status: 'queued', url: null })
    expect((await app.inject({ method: 'POST', url: '/api/skill-avatars/local', headers,
      payload: { localSkillId: 'a', name: 'A', description: 'Test' } })).statusCode).toBe(200)
    now.mockReturnValue(1_060_000)
    expect((await app.inject({ url: '/api/skill-avatars/export?localSkillIds=a', headers })).statusCode).toBe(200)
  } finally { now.mockRestore() }
})
