vi.mock('./avatar-model.js', async (original) => ({ ...await original<typeof import('./avatar-model.js')>(), mirrorSkillAvatar: vi.fn().mockResolvedValue('mirrored-job') }))
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillAvatar } from '@prisma/client'
import { SKILL_ART_FIXED_STYLE } from './skill-avatar-prompt.js'

/**
 * #214 custom avatars against a small stateful fake of the two tables the avatar
 * code touches, so the real `persist / processAvatar / upload / restore` run end to
 * end with FAL and Picem mocked; #221's attempt ledger and transaction rollback are faked
 * too. Row semantics (CAS on leaseToken, quota counting, concurrency)
 * are the ones the PostgreSQL tests check on real constraints.
 */
type Row = SkillAvatar
type Attempt = { id: string; avatarId: string; day: Date; kind: string; createdAt: Date; releasedAt: Date | null }
type SkillRow = { id: string; authorId: string; deletedAt: Date | null; avatarUrl: string | null; avatarStatus: string; displayName: string; description: string; triggerScenarios: string[] }
const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(), skills: new Map<string, SkillRow>(), attempts: new Map<string, Attempt>(),
  config: { SKILL_AVATARS_ENABLED: true, SKILL_MAX_PER_USER: 50, SKILL_AVATAR_DAILY_LIMIT: 3 },
  draft: vi.fn(), submit: vi.fn(), poll: vi.fn(), download: vi.fn(), upload: vi.fn(), lockCalls: 0,
}))

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    const actual = (row as unknown as Record<string, unknown>)[key]
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      const filter = value as { not?: unknown; gte?: Date; in?: unknown[] }
      if ('not' in filter) return actual !== filter.not
      if (filter.gte) return actual instanceof Date && actual >= filter.gte
      if (filter.in) return filter.in.includes(actual)
    }
    return actual === value
  })
}
function apply(row: Row, data: Record<string, unknown>): void {
  const target = row as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(data)) {
    if (key === 'skill') { target.skillId = (value as { connect: { id: string } }).connect.id; continue }
    if (value && typeof value === 'object' && 'increment' in (value as object)) target[key] = Number(target[key]) + (value as { increment: number }).increment
    else target[key] = value
  }
  row.updatedAt = new Date()
}
function findRow(where: Record<string, unknown>): Row | null {
  if (typeof where.id === 'string') return state.rows.get(where.id) ?? null
  const key = where.ownerId_localSkillId as { ownerId: string; localSkillId: string } | undefined
  if (key) return [...state.rows.values()].find(row => row.ownerId === key.ownerId && row.localSkillId === key.localSkillId) ?? null
  if (typeof where.skillId === 'string') return [...state.rows.values()].find(row => row.skillId === where.skillId) ?? null
  return null
}
const fake = vi.hoisted(() => ({}) as Record<string, unknown>)
Object.assign(fake, {
  skillAvatar: {
    findUnique: async (args: { where: Record<string, unknown> }): Promise<Row | null> => { const row = findRow(args.where); return row ? { ...row } : null },
    findUniqueOrThrow: async (args: { where: Record<string, unknown> }): Promise<Row> => { const row = findRow(args.where); if (!row) throw new Error('missing'); return { ...row } },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }): Promise<Row> => { const row = state.rows.get(args.where.id)!; apply(row, args.data); return { ...row } },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }> => {
      let count = 0
      for (const row of state.rows.values()) if (matches(row, args.where)) { apply(row, args.data); count += 1 }
      return { count }
    },
    count: async (args: { where: Record<string, unknown> }): Promise<number> => [...state.rows.values()].filter(row => matches(row, args.where)).length,
    create: async (args: { data: Record<string, unknown> }): Promise<Row> => {
      const now = new Date()
      const row = { id: randomUUID(), localSkillId: null, skillId: null, prompt: null, status: 'queued', requestId: null, submittedAt: null,
        imageUrl: null, imageData: null, imageSha256: null, assetId: null, url: null, errorCode: null, attempts: 0, nextAttemptAt: now,
        leaseToken: null, leaseUntil: null, source: 'generated', customAssetId: null, customUrl: null, customUpdatedAt: null, queuedAt: null,
        createdAt: now, updatedAt: now, ...args.data } as Row
      state.rows.set(row.id, row)
      return { ...row }
    },
  },
  skillAvatarAlias: { findUnique: async (): Promise<null> => null, create: async (): Promise<void> => undefined, findMany: async (): Promise<[]> => [] },
  skill: {
    findFirst: async (args: { where: { id: string; authorId?: string } }): Promise<SkillRow | null> => {
      const skill = state.skills.get(args.where.id)
      return skill && !skill.deletedAt && (!args.where.authorId || skill.authorId === args.where.authorId) ? skill : null
    },
    update: async (args: { where: { id: string }; data: Partial<SkillRow> }): Promise<void> => { Object.assign(state.skills.get(args.where.id)!, args.data) },
    updateMany: async (args: { where: { id: string }; data: Partial<SkillRow> }): Promise<{ count: number }> => {
      const skill = state.skills.get(args.where.id); if (skill) Object.assign(skill, args.data); return { count: skill ? 1 : 0 }
    },
  },
  marketplaceListing: { findUnique: async (): Promise<null> => null },
  libraryEntry: { findFirst: async (): Promise<null> => null },
  $queryRaw: async (): Promise<void> => { state.lockCalls += 1 },
  skillAvatarGenerationAttempt: {
    count: async (args: { where: { day: Date; releasedAt: null } }): Promise<number> =>
      [...state.attempts.values()].filter(item => item.day.getTime() === args.where.day.getTime() && item.releasedAt === null).length,
    create: async (args: { data: Omit<Attempt, 'id' | 'releasedAt'> }): Promise<Attempt> => {
      if (!state.rows.has(args.data.avatarId)) throw new Error('attempt FK violation')
      const item = { id: randomUUID(), releasedAt: null, ...args.data }
      state.attempts.set(item.id, item)
      return { ...item }
    },
    findFirst: async (args: { where: { avatarId: string; releasedAt: null } }): Promise<Attempt | null> =>
      [...state.attempts.values()].filter(item => item.avatarId === args.where.avatarId && item.releasedAt === null)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null,
    update: async (args: { where: { id: string }; data: Partial<Attempt> }): Promise<void> => { Object.assign(state.attempts.get(args.where.id)!, args.data) },
  },
  // Rolls back like PostgreSQL: a transaction that throws leaves every row (and the ledger) as it found them.
  $transaction: async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    const snapshot = <T extends object>(map: Map<string, T>): Map<string, T> => new Map([...map].map(([key, value]) => [key, { ...value }]))
    const restore = <T extends object>(map: Map<string, T>, saved: Map<string, T>): void => {
      for (const key of [...map.keys()]) if (!saved.has(key)) map.delete(key)
      for (const [key, value] of saved) {
        const live = map.get(key)
        if (live) { for (const field of Object.keys(live)) delete (live as Record<string, unknown>)[field]; Object.assign(live, value) } else map.set(key, value)
      }
    }
    const saved = { rows: snapshot(state.rows), skills: snapshot(state.skills), attempts: snapshot(state.attempts) }
    try { return await fn(fake) } catch (error) {
      restore(state.rows, saved.rows); restore(state.skills, saved.skills); restore(state.attempts, saved.attempts)
      throw error
    }
  },
})
vi.mock('../db.js', () => ({ db: fake }))
vi.mock('../config.js', () => ({ config: state.config }))
vi.mock('../routes/skills.js', () => ({ requestConfiguredAiDraft: state.draft }))
vi.mock('./mutation-lock.js', () => ({ lockUserMutation: vi.fn() }))
vi.mock('./fal.js', async (original) => ({ ...await original<typeof import('./fal.js')>(),
  submitFalAvatar: state.submit, pollFalAvatar: state.poll, downloadFalAvatar: state.download }))
vi.mock('./media.js', () => ({ uploadMedia: state.upload, publicImageUrl: (url: string): string => url }))

import {
  avatarDto, ensureSkillAvatar, prepareCustomAvatar, processAvatar, restoreGeneratedAvatar, retryFailedAvatar, uploadCustomAvatar, utcDay,
} from './skill-avatars.js'

const OWNER = 'owner'
const CUSTOM_URL = 'https://picem-media.whatonearth.work/custom.webp'
const GENERATED_URL = 'https://picem-media.whatonearth.work/generated.jpg'
const input = { name: 'Research', description: 'Organize sources for /Users/example/notes', scenarios: ['weekly digest'] }

function png(width: number, height: number): string {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  return bytes.toString('base64')
}
const image = { mimeType: 'image/png' as const, dataBase64: png(512, 512) }
const midnight = (): Date => { const value = new Date(); value.setUTCHours(0, 0, 0, 0); return value }
const yesterday = (): Date => new Date(midnight().getTime() - 3_600_000)

function seed(fields: Partial<Row>): Row {
  const now = new Date()
  const row = { id: randomUUID(), ownerId: OWNER, localSkillId: 'local-skill', skillId: null,
    input: { name: 'Seeded', description: 'Seeded input', scenarios: [] }, inputFingerprint: 'fp', promptVersion: 'v1',
    prompt: null, status: 'queued', requestId: null, submittedAt: null, imageUrl: null, imageData: null, imageSha256: null,
    assetId: null, url: null, errorCode: null, attempts: 0, nextAttemptAt: now, leaseToken: null, leaseUntil: null,
    source: 'generated', customAssetId: null, customUrl: null, customUpdatedAt: null, queuedAt: now, createdAt: now, updatedAt: now, ...fields } as Row
  state.rows.set(row.id, row)
  return row
}
function boundSkill(): SkillRow {
  const skill = { id: randomUUID(), authorId: OWNER, deletedAt: null, avatarUrl: null, avatarStatus: 'pending', displayName: 'Cloud', description: 'Cloud skill', triggerScenarios: [] }
  state.skills.set(skill.id, skill)
  return skill
}
const row = (id: string): Row => state.rows.get(id)!

beforeEach(() => {
  state.rows.clear(); state.skills.clear(); state.attempts.clear(); state.lockCalls = 0
  state.config.SKILL_AVATARS_ENABLED = true; state.config.SKILL_AVATAR_DAILY_LIMIT = 3
  vi.clearAllMocks()
  state.upload.mockResolvedValue({ assetId: 'ast_custom', url: CUSTOM_URL })
  vi.unstubAllGlobals()
})

describe('custom avatar display and validation', () => {
  it('shows a custom image whatever the generation task is doing', () => {
    for (const status of ['queued', 'awaiting', 'failed', 'needs_review', 'cancelled', 'ready']) {
      expect(avatarDto({ status, url: GENERATED_URL, source: 'custom', customUrl: CUSTOM_URL })).toEqual({ avatarUrl: CUSTOM_URL, avatarStatus: 'ready', avatarSource: 'custom' })
    }
    expect(avatarDto({ status: 'ready', url: GENERATED_URL, source: 'generated', customUrl: null })).toEqual({ avatarUrl: GENERATED_URL, avatarStatus: 'ready', avatarSource: 'generated' })
  })
  it('accepts only ≤ 2 MB square 256–1024 px images whose bytes match their type', () => {
    expect(prepareCustomAvatar(image).sha256).toMatch(/^[0-9a-f]{64}$/)
    const reject = (value: { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; dataBase64: string }, code: string): void => {
      expect(() => prepareCustomAvatar(value)).toThrow(expect.objectContaining({ statusCode: 400, code }))
    }
    reject({ mimeType: 'image/png', dataBase64: png(512, 400) }, 'AVATAR_IMAGE_DIMENSIONS')
    reject({ mimeType: 'image/png', dataBase64: png(128, 128) }, 'AVATAR_IMAGE_DIMENSIONS')
    reject({ mimeType: 'image/png', dataBase64: png(2048, 2048) }, 'AVATAR_IMAGE_DIMENSIONS')
    reject({ mimeType: 'image/jpeg', dataBase64: png(512, 512) }, 'AVATAR_IMAGE_INVALID')
    reject({ mimeType: 'image/png', dataBase64: 'not base64!' }, 'AVATAR_IMAGE_INVALID')
    reject({ mimeType: 'image/png', dataBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }, 'AVATAR_IMAGE_TOO_LARGE')
  })
})

describe('upload beats generation', () => {
  it('an unregistered local Skill gets an upload-only cancelled row with its sanitized input and no quota', async () => {
    const result = await uploadCustomAvatar({ ownerId: OWNER, localSkillId: 'fresh-local', input, image })
    expect(result).toMatchObject({ status: 'cancelled', source: 'custom', customUrl: CUSTOM_URL, customAssetId: 'ast_custom', queuedAt: null, localSkillId: 'fresh-local' })
    expect(JSON.stringify(result.input)).not.toContain('/Users/')
    expect(result.inputFingerprint).toMatch(/^[0-9a-f]{64}$/)
    const ownerRef = state.upload.mock.calls[0]![3].ownerRef as string
    expect(ownerRef).toBe(`skill-avatar:${result.id}:custom:${prepareCustomAvatar(image).sha256}`)
    expect(state.upload.mock.calls[0]![3]).toMatchObject({ purpose: 'avatar', visibility: 'public', userId: OWNER })
    expect(state.lockCalls).toBe(0) // never reserved quota
    expect(state.submit).not.toHaveBeenCalled()
    // Same file again: the same task, the same idempotent Picem key.
    await uploadCustomAvatar({ ownerId: OWNER, localSkillId: 'fresh-local', input, image })
    expect(state.rows.size).toBe(1)
    expect(state.upload.mock.calls[1]![3].ownerRef).toBe(ownerRef)
  })
  it('a local upload without an introduction is refused before anything is stored', async () => {
    await expect(uploadCustomAvatar({ ownerId: OWNER, localSkillId: 'fresh-local', image })).rejects.toMatchObject({ statusCode: 400, code: 'AVATAR_INPUT_REQUIRED' })
    expect(state.upload).not.toHaveBeenCalled()
    expect(state.rows.size).toBe(0)
  })
  it('queued with no lease → cancelled with no FAL call; restoring queues it again with quota', async () => {
    const task = seed({ status: 'queued', leaseToken: null, queuedAt: yesterday() })
    await uploadCustomAvatar({ ownerId: OWNER, localSkillId: 'local-skill', input, image })
    expect(row(task.id)).toMatchObject({ status: 'cancelled', source: 'custom' })
    expect(row(task.id).input).toEqual({ name: 'Seeded', description: 'Seeded input', scenarios: [] }) // input never changes
    expect(state.draft).not.toHaveBeenCalled(); expect(state.submit).not.toHaveBeenCalled()
    const restored = await restoreGeneratedAvatar(OWNER, { localSkillId: 'local-skill' })
    expect(restored).toMatchObject({ status: 'queued', source: 'generated', customUrl: null, customAssetId: null, attempts: 0, errorCode: null })
    expect(restored.queuedAt!.getTime()).toBeGreaterThanOrEqual(midnight().getTime()) // a cross-day restore counts today
    expect(avatarDto(restored)).toEqual({ avatarUrl: null, avatarStatus: 'pending', avatarSource: 'generated' })
  })
  it('a claimed queued task keeps running: upload never cancels a leased task', async () => {
    const task = seed({ status: 'queued', leaseToken: 'worker-lease' })
    await uploadCustomAvatar({ ownerId: OWNER, localSkillId: 'local-skill', input, image })
    expect(row(task.id)).toMatchObject({ status: 'queued', leaseToken: 'worker-lease', source: 'custom' })
  })
  it('submitting in flight: FAL\'s requestId still lands and the Skill keeps showing the custom image', async () => {
    const skill = boundSkill()
    const task = seed({ status: 'queued', leaseToken: 'worker-lease', skillId: skill.id })
    state.draft.mockResolvedValue('A square illustration of a vermilion ribbon gathering mint leaves into a bundle. '.repeat(4) + '\n\n' + SKILL_ART_FIXED_STYLE)
    let release: (value: string) => void = () => undefined
    state.submit.mockReturnValue(new Promise<string>(resolve => { release = resolve }))
    const work = processAvatar({ ...row(task.id) })
    await vi.waitFor(() => expect(state.submit).toHaveBeenCalled())
    expect(row(task.id).status).toBe('submitting')
    await uploadCustomAvatar({ ownerId: OWNER, skillId: skill.id, image })
    release('fal-request-1')
    await work
    expect(row(task.id)).toMatchObject({ status: 'awaiting', requestId: 'fal-request-1', source: 'custom', leaseToken: 'worker-lease' })
    expect(skill).toMatchObject({ avatarUrl: CUSTOM_URL, avatarStatus: 'ready' })
  })
  it('transferring in flight: the generated asset lands, display stays custom, restoring shows the generated image', async () => {
    const skill = boundSkill()
    const task = seed({ status: 'transferring', leaseToken: 'worker-lease', skillId: skill.id, imageData: Buffer.from('jpeg'), requestId: 'fal-request-2' })
    await uploadCustomAvatar({ ownerId: OWNER, skillId: skill.id, image })
    state.upload.mockResolvedValue({ assetId: 'ast_generated', url: GENERATED_URL })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { headers: { 'content-type': 'image/jpeg' } })))
    await processAvatar({ ...row(task.id) })
    expect(row(task.id)).toMatchObject({ status: 'ready', url: GENERATED_URL, assetId: 'ast_generated', source: 'custom' })
    expect(skill).toMatchObject({ avatarUrl: CUSTOM_URL, avatarStatus: 'ready' })
    const restored = await restoreGeneratedAvatar(OWNER, { skillId: skill.id })
    expect(avatarDto(restored)).toEqual({ avatarUrl: GENERATED_URL, avatarStatus: 'ready', avatarSource: 'generated' })
    expect(skill).toMatchObject({ avatarUrl: GENERATED_URL, avatarStatus: 'ready' })
    expect(state.lockCalls).toBe(0)
  })
  it('needs_review → upload → restore stays needs_review: never queued, never paid again', async () => {
    const task = seed({ status: 'needs_review', errorCode: 'submission_unknown', queuedAt: yesterday() })
    await uploadCustomAvatar({ ownerId: OWNER, localSkillId: 'local-skill', input, image })
    const restored = await restoreGeneratedAvatar(OWNER, { localSkillId: 'local-skill' })
    expect(restored).toMatchObject({ status: 'needs_review', errorCode: 'submission_unknown', source: 'generated' })
    expect(row(task.id).queuedAt!.getTime()).toBeLessThan(midnight().getTime())
    expect(state.lockCalls).toBe(0)
  })
  it('failed and in-flight tasks are left as they are on restore', async () => {
    seed({ status: 'failed', errorCode: 'fal_generation_failed', source: 'custom', customUrl: CUSTOM_URL, customAssetId: 'a' })
    expect(await restoreGeneratedAvatar(OWNER, { localSkillId: 'local-skill' })).toMatchObject({ status: 'failed', errorCode: 'fal_generation_failed', source: 'generated' })
    seed({ localSkillId: 'second', status: 'awaiting', requestId: 'r', leaseToken: 'l', source: 'custom', customUrl: CUSTOM_URL, customAssetId: 'a' })
    expect(await restoreGeneratedAvatar(OWNER, { localSkillId: 'second' })).toMatchObject({ status: 'awaiting', requestId: 'r', leaseToken: 'l', source: 'generated' })
  })
  it('restoring an already generated avatar is idempotent and spends nothing', async () => {
    const task = seed({ status: 'ready', url: GENERATED_URL, assetId: 'g' })
    const before = { ...row(task.id) }
    expect(await restoreGeneratedAvatar(OWNER, { localSkillId: 'local-skill' })).toMatchObject({ status: 'ready', source: 'generated' })
    expect(row(task.id).updatedAt).toEqual(before.updatedAt)
    expect(state.lockCalls).toBe(0)
  })
  it('another account never reaches the task', async () => {
    seed({ ownerId: 'someone-else', status: 'cancelled', source: 'custom', customUrl: CUSTOM_URL, customAssetId: 'a' })
    await expect(restoreGeneratedAvatar(OWNER, { localSkillId: 'local-skill' })).rejects.toMatchObject({ statusCode: 404 })
    const skill = boundSkill(); skill.authorId = 'someone-else'
    await expect(restoreGeneratedAvatar(OWNER, { skillId: skill.id })).rejects.toMatchObject({ statusCode: 404 })
    await expect(uploadCustomAvatar({ ownerId: OWNER, skillId: skill.id, image })).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('daily quota ledger (#221): one row per new paid attempt', () => {
  const custom = { source: 'custom', customUrl: CUSTOM_URL, customAssetId: 'a' } as const
  const attempts = (avatarId?: string): Attempt[] => [...state.attempts.values()].filter(item => !avatarId || item.avatarId === avatarId)
  const usedToday = (): number => attempts().filter(item => item.day.getTime() === utcDay(new Date()).getTime() && item.releasedAt === null).length
  /** Fills today's quota with attempts of unrelated ready tasks. */
  const fillToday = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
      const busy = seed({ localSkillId: `busy-${index}`, status: 'ready', url: GENERATED_URL, assetId: 'g' })
      state.attempts.set(randomUUID(), { id: randomUUID(), avatarId: busy.id, day: utcDay(new Date()), kind: 'create', createdAt: new Date(), releasedAt: null })
    }
  }

  it('ensure: a new queued task records +1 create; a full day refuses it and leaves no task and no attempt', async () => {
    const created = await ensureSkillAvatar({ ownerId: OWNER, localSkillId: 'new-task', input })
    expect(created).toMatchObject({ status: 'queued' })
    expect(created.queuedAt).toBeInstanceOf(Date)
    expect(attempts(created.id)).toMatchObject([{ kind: 'create', releasedAt: null, day: utcDay(new Date()) }])
    fillToday(2)
    const before = state.rows.size
    await expect(ensureSkillAvatar({ ownerId: OWNER, localSkillId: 'refused', input })).rejects.toMatchObject({ statusCode: 429, code: 'AVATAR_DAILY_QUOTA' })
    expect(state.rows.size).toBe(before)
    expect(usedToday()).toBe(3)
  })

  it('restore of a cancelled task records +1 restore; a full day is 429 with status, custom image and source unchanged; disabled is 503', async () => {
    const task = seed({ status: 'cancelled', queuedAt: null, ...custom })
    fillToday(3)
    await expect(restoreGeneratedAvatar(OWNER, { localSkillId: 'local-skill' })).rejects.toMatchObject({ statusCode: 429, code: 'AVATAR_DAILY_QUOTA' })
    expect(row(task.id)).toMatchObject({ status: 'cancelled', ...custom, queuedAt: null })
    expect(attempts(task.id)).toEqual([])
    state.config.SKILL_AVATAR_DAILY_LIMIT = 10; state.config.SKILL_AVATARS_ENABLED = false
    await expect(restoreGeneratedAvatar(OWNER, { localSkillId: 'local-skill' })).rejects.toMatchObject({ statusCode: 503, code: 'AVATAR_GENERATION_DISABLED' })
    expect(row(task.id)).toMatchObject({ status: 'cancelled', ...custom })
    state.config.SKILL_AVATARS_ENABLED = true
    await expect(restoreGeneratedAvatar(OWNER, { localSkillId: 'local-skill' })).resolves.toMatchObject({ status: 'queued', source: 'generated' })
    expect(attempts(task.id)).toMatchObject([{ kind: 'restore', releasedAt: null }])
  })

  it('retry with neither requestId nor image is a redraw: failed → queued and +1 retry; a full day keeps failed / errorCode', async () => {
    const task = seed({ status: 'failed', errorCode: 'fal_generation_failed', leaseToken: null, attempts: 5 })
    fillToday(3)
    await expect(retryFailedAvatar(OWNER, task.id)).rejects.toMatchObject({ statusCode: 429, code: 'AVATAR_DAILY_QUOTA' })
    expect(row(task.id)).toMatchObject({ status: 'failed', errorCode: 'fal_generation_failed', attempts: 5 })
    expect(attempts(task.id)).toEqual([])
    state.config.SKILL_AVATAR_DAILY_LIMIT = 4
    await expect(retryFailedAvatar(OWNER, task.id)).resolves.toMatchObject({ transitioned: true, avatar: { status: 'queued', errorCode: null, attempts: 0 } })
    expect(attempts(task.id)).toMatchObject([{ kind: 'retry', releasedAt: null }])
  })

  it('retry with a requestId resumes polling and with saved image data resumes the transfer: free, no quota check', async () => {
    fillToday(3) // a full day does not matter for continuations
    const polling = seed({ localSkillId: 'poll', status: 'failed', requestId: 'accepted', leaseToken: null })
    const transfer = seed({ localSkillId: 'transfer', status: 'failed', requestId: 'accepted', imageData: Buffer.from('jpeg'), leaseToken: null })
    const byUrl = seed({ localSkillId: 'by-url', status: 'failed', imageUrl: 'https://fal.example/a.jpg', leaseToken: null })
    await expect(retryFailedAvatar(OWNER, polling.id)).resolves.toMatchObject({ transitioned: true, avatar: { status: 'awaiting' } })
    await expect(retryFailedAvatar(OWNER, transfer.id)).resolves.toMatchObject({ transitioned: true, avatar: { status: 'transferring' } })
    await expect(retryFailedAvatar(OWNER, byUrl.id)).resolves.toMatchObject({ transitioned: true, avatar: { status: 'transferring' } })
    expect(state.lockCalls).toBe(0)
    expect(attempts(polling.id).length + attempts(transfer.id).length + attempts(byUrl.id).length).toBe(0)
  })

  it('needs_review and claimed tasks never move and never spend', async () => {
    const review = seed({ status: 'needs_review', errorCode: 'submission_unknown' })
    await expect(retryFailedAvatar(OWNER, review.id)).resolves.toMatchObject({ transitioned: false, avatar: { status: 'needs_review' } })
    const leased = seed({ localSkillId: 'leased', status: 'failed', leaseToken: 'worker' })
    await expect(retryFailedAvatar(OWNER, leased.id)).resolves.toMatchObject({ transitioned: false })
    expect(attempts()).toEqual([])
  })

  it('HTTP duplicates: concurrent or repeated retries move the task once and spend once; restore likewise', async () => {
    const task = seed({ status: 'failed', leaseToken: null })
    const results = await Promise.all([retryFailedAvatar(OWNER, task.id), retryFailedAvatar(OWNER, task.id), retryFailedAvatar(OWNER, task.id)])
    expect(results.filter(result => result.transitioned)).toHaveLength(1)
    expect(await retryFailedAvatar(OWNER, task.id)).toMatchObject({ transitioned: false })
    expect(attempts(task.id)).toHaveLength(1)
    const restorable = seed({ localSkillId: 'restorable', status: 'cancelled', queuedAt: null, ...custom })
    await Promise.all([restoreGeneratedAvatar(OWNER, { localSkillId: 'restorable' }), restoreGeneratedAvatar(OWNER, { localSkillId: 'restorable' })])
    await restoreGeneratedAvatar(OWNER, { localSkillId: 'restorable' })
    expect(attempts(restorable.id)).toHaveLength(1)
  })

  it('the same task pays twice on one day: retry → fails again → retry counts 1 + 1 (plus its create)', async () => {
    const created = await ensureSkillAvatar({ ownerId: OWNER, localSkillId: 'flaky', input })
    for (let round = 0; round < 2; round += 1) {
      Object.assign(row(created.id), { status: 'failed', errorCode: 'fal_generation_failed', leaseToken: null })
      await expect(retryFailedAvatar(OWNER, created.id)).resolves.toMatchObject({ transitioned: true })
    }
    expect(attempts(created.id).map(item => item.kind)).toEqual(['create', 'retry', 'retry'])
    expect(usedToday()).toBe(3)
    state.config.SKILL_AVATAR_DAILY_LIMIT = 3
    await expect(ensureSkillAvatar({ ownerId: OWNER, localSkillId: 'one-more', input })).rejects.toMatchObject({ statusCode: 429 })
  })

  it('upload cancels an unclaimed queued task and refunds its attempt; same-day restore nets 1; a claimed task keeps its attempt', async () => {
    const created = await ensureSkillAvatar({ ownerId: OWNER, localSkillId: 'new-task', input })
    expect(usedToday()).toBe(1)
    await uploadCustomAvatar({ ownerId: OWNER, localSkillId: 'new-task', input, image })
    expect(row(created.id).status).toBe('cancelled')
    expect(attempts(created.id)[0]!.releasedAt).toBeInstanceOf(Date)
    expect(usedToday()).toBe(0)
    await restoreGeneratedAvatar(OWNER, { localSkillId: 'new-task' })
    expect(usedToday()).toBe(1) // released 1, restored 1
    expect(attempts(created.id).map(item => [item.kind, item.releasedAt === null])).toEqual([['create', false], ['restore', true]])
    // The worker claimed it: an upload no longer cancels it, so the attempt stays spent.
    Object.assign(row(created.id), { leaseToken: 'worker' })
    await uploadCustomAvatar({ ownerId: OWNER, localSkillId: 'new-task', input, image })
    expect(row(created.id).status).toBe('queued')
    expect(usedToday()).toBe(1)
  })

  it('counts by UTC day: yesterday\'s attempts do not use today\'s quota; a cross-day restore spends today', async () => {
    const task = seed({ status: 'cancelled', queuedAt: yesterday(), ...custom })
    for (let index = 0; index < 3; index += 1) state.attempts.set(randomUUID(), { id: randomUUID(), avatarId: task.id, day: utcDay(yesterday()), kind: 'create', createdAt: yesterday(), releasedAt: null })
    await expect(restoreGeneratedAvatar(OWNER, { localSkillId: 'local-skill' })).resolves.toMatchObject({ status: 'queued' })
    expect(usedToday()).toBe(1)
    expect(utcDay(new Date('2026-10-13T23:59:59.999Z')).toISOString()).toBe('2026-10-13T00:00:00.000Z')
    expect(utcDay(new Date('2026-10-14T00:00:00.000Z')).toISOString()).toBe('2026-10-14T00:00:00.000Z')
  })

  it('upload-only rows never touch the ledger', async () => {
    await uploadCustomAvatar({ ownerId: OWNER, localSkillId: 'upload-only', input, image })
    expect(attempts()).toEqual([])
    expect(state.lockCalls).toBe(0)
  })
})
