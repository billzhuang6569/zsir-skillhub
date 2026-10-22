vi.mock('../lib/avatar-model.js', async (original) => ({ ...await original<typeof import('../lib/avatar-model.js')>(), mirrorSkillAvatar: vi.fn().mockResolvedValue('mirrored-job') }))
import { randomUUID } from 'node:crypto'
import type { SkillAvatar } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #246 ops `retry` against the real `retryFailedAvatar` / ledger code and a stateful fake of the
 * three tables it touches. `$transaction` rolls back on error like PostgreSQL, so a refused
 * (quota-full) retry leaves no trace.
 */
type Row = SkillAvatar
type Attempt = { id: string; avatarId: string; day: Date; kind: string; createdAt: Date; releasedAt: Date | null }
const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(), attempts: new Map<string, Attempt>(), skills: new Map<string, { id: string; authorId: string; deletedAt: Date | null; avatarStatus: string }>(),
  config: { SKILL_AVATARS_ENABLED: true, SKILL_AVATAR_DAILY_LIMIT: 3 }, writes: 0,
}))
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => value === null ? row[key] === null : row[key] === value)
}
const fake = vi.hoisted(() => ({}) as Record<string, unknown>)
Object.assign(fake, {
  skillAvatar: {
    findMany: async (args: { where: { status: string }; take: number }): Promise<Array<{ id: string }>> =>
      [...state.rows.values()].filter(row => row.status === args.where.status).sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime()).slice(0, args.take).map(row => ({ id: row.id })),
    findUnique: async (args: { where: { id: string } }): Promise<Row | null> => { const row = state.rows.get(args.where.id); return row ? { ...row } : null },
    findUniqueOrThrow: async (args: { where: { id: string } }): Promise<Row> => ({ ...state.rows.get(args.where.id)! }),
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }> => {
      let count = 0
      for (const row of state.rows.values()) if (matches(row as unknown as Record<string, unknown>, args.where)) { Object.assign(row, args.data, { updatedAt: new Date() }); count += 1; state.writes += 1 }
      return { count }
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }): Promise<Row> => { const row = state.rows.get(args.where.id)!; Object.assign(row, args.data); state.writes += 1; return { ...row } },
  },
  skill: {
    updateMany: async (args: { where: { id: string; authorId: string }; data: { avatarStatus: string } }): Promise<{ count: number }> => {
      const skill = state.skills.get(args.where.id)
      if (!skill || skill.authorId !== args.where.authorId || skill.deletedAt) return { count: 0 }
      Object.assign(skill, args.data); state.writes += 1; return { count: 1 }
    },
  },
  skillAvatarGenerationAttempt: {
    count: async (args: { where: { day: Date } }): Promise<number> => [...state.attempts.values()].filter(item => item.day.getTime() === args.where.day.getTime() && item.releasedAt === null).length,
    create: async (args: { data: Omit<Attempt, 'id' | 'releasedAt'> }): Promise<void> => { const id = randomUUID(); state.attempts.set(id, { id, releasedAt: null, ...args.data }); state.writes += 1 },
  },
  $queryRaw: async (): Promise<void> => undefined,
  $transaction: async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    const rows = new Map([...state.rows].map(([key, value]) => [key, { ...value }]))
    const attempts = new Map(state.attempts)
    const skills = new Map([...state.skills].map(([key, value]) => [key, { ...value }]))
    try { return await fn(fake) } catch (error) {
      state.rows.clear(); rows.forEach((value, key) => state.rows.set(key, value))
      state.attempts.clear(); attempts.forEach((value, key) => state.attempts.set(key, value))
      state.skills.clear(); skills.forEach((value, key) => state.skills.set(key, value))
      throw error
    }
  },
})
vi.mock('../db.js', () => ({ db: fake }))
vi.mock('../config.js', () => ({ config: state.config }))
vi.mock('../routes/skills.js', () => ({ requestConfiguredAiDraft: vi.fn() }))
vi.mock('../lib/media.js', () => ({ uploadMedia: vi.fn(), publicImageUrl: (url: string): string => url }))
vi.mock('../lib/fal.js', async (original) => ({ ...await original<typeof import('../lib/fal.js')>(), findSubmittedFalAvatar: vi.fn() }))

import { utcDay } from '../lib/skill-avatars.js'
import { parseAvatarOperation, runAvatarOperation, type RetryRow } from './skill-avatars.js'

let tick = 0
function seed(fields: Partial<Row> = {}): Row {
  const at = new Date(Date.now() - 86_400_000 + (tick += 1_000))
  const row = { id: randomUUID(), ownerId: 'owner', localSkillId: null, skillId: null, input: {}, inputFingerprint: 'fp', promptVersion: 'v1', prompt: 'private drawing prompt',
    status: 'failed', requestId: null, submittedAt: null, imageUrl: null, imageData: null, imageSha256: null, assetId: null, url: null,
    errorCode: 'upstream_unavailable', attempts: 5, nextAttemptAt: at, leaseToken: null, leaseUntil: null, source: 'generated', customAssetId: null,
    customUrl: null, customUpdatedAt: null, queuedAt: at, createdAt: at, updatedAt: at, ...fields } as Row
  state.rows.set(row.id, row)
  return row
}
const fillToday = (count: number): void => {
  for (let index = 0; index < count; index += 1) { const id = randomUUID(); state.attempts.set(id, { id, avatarId: 'other', day: utcDay(new Date()), kind: 'create', createdAt: new Date(), releasedAt: null }) }
}
const run = async (args: string[]): Promise<{ dryRun: boolean; tasks: RetryRow[]; quotaToday: { remaining: number; used: number; limit: number }; paidAttemptsIfApplied?: number }> =>
  await runAvatarOperation(parseAvatarOperation(args)) as never
const retries = (avatarId: string): number => [...state.attempts.values()].filter(item => item.avatarId === avatarId && item.kind === 'retry').length

beforeEach(() => {
  state.rows.clear(); state.attempts.clear(); state.skills.clear(); state.writes = 0
  state.config.SKILL_AVATARS_ENABLED = true; state.config.SKILL_AVATAR_DAILY_LIMIT = 3
})

describe('parsing', () => {
  it('needs --task (repeatable) or --all-failed, not both, and keeps other modes single-task', () => {
    const [a, b] = [randomUUID(), randomUUID()]
    expect(parseAvatarOperation(['retry', '--task', a, '--task', b])).toMatchObject({ mode: 'retry', apply: false, tasks: [a, b], allFailed: false })
    expect(parseAvatarOperation(['retry', '--all-failed', '--apply'])).toMatchObject({ mode: 'retry', apply: true, tasks: [], allFailed: true })
    for (const bad of [['retry'], ['retry', '--task', a, '--all-failed'], ['retry', '--task', 'nope'], ['retry', '--task', a, '--task', a], ['inspect', '--task', a, '--task', b], ['report', '--all-failed']]) {
      expect(() => parseAvatarOperation(bad), bad.join(' ')).toThrow()
    }
    expect(parseAvatarOperation(['inspect', '--task', a]).task).toBe(a)
  })
})

describe('dry run', () => {
  it('writes nothing and previews status, target, charge and today\'s quota without prompts, URLs or identities', async () => {
    const redraw = seed()
    const poll = seed({ requestId: 'fal-request-private' })
    const transfer = seed({ imageUrl: 'https://fal.example/private.jpg' })
    fillToday(1)
    const result = await run(['retry', '--task', redraw.id, '--task', poll.id, '--task', transfer.id])
    expect(result.dryRun).toBe(true)
    expect(state.writes).toBe(0)
    expect(result.quotaToday).toMatchObject({ limit: 3, used: 1, remaining: 2 })
    expect(result.paidAttemptsIfApplied).toBe(1)
    expect(result.tasks).toEqual([
      { task: redraw.id, status: 'failed', target: 'queued', chargesAttempt: true, outcome: 'would_retry' },
      { task: poll.id, status: 'failed', target: 'awaiting', chargesAttempt: false, outcome: 'would_retry' },
      { task: transfer.id, status: 'failed', target: 'transferring', chargesAttempt: false, outcome: 'would_retry' },
    ])
    expect(JSON.stringify(result)).not.toMatch(/private|owner|https?:/)
  })
})

describe('apply', () => {
  it('moves only failed tasks, like the API retry: attempts and errorCode reset, one ledger row only for a redraw, Skill status synced', async () => {
    state.skills.set('skill-1', { id: 'skill-1', authorId: 'owner', deletedAt: null, avatarStatus: 'failed' })
    const redraw = seed({ skillId: 'skill-1' })
    const poll = seed({ requestId: 'fal-request' })
    const ready = seed({ status: 'ready', assetId: 'a', url: 'https://picem-media.whatonearth.work/a.jpg', errorCode: null })
    const review = seed({ status: 'needs_review', errorCode: 'submission_unknown' })
    const custom = seed({ source: 'custom', customAssetId: 'c', customUrl: 'https://picem-media.whatonearth.work/c.webp' })
    const missing = randomUUID()
    const result = await run(['retry', '--apply', '--task', redraw.id, '--task', poll.id, '--task', ready.id, '--task', review.id, '--task', custom.id, '--task', missing])
    expect(result.tasks.map(row => [row.task, row.outcome, row.target, row.chargesAttempt])).toEqual([
      [redraw.id, 'retried', 'queued', true], [poll.id, 'retried', 'awaiting', false], [ready.id, 'not_failed', null, false],
      [review.id, 'needs_review', null, false], [custom.id, 'custom_active', null, false], [missing, 'not_found', null, false],
    ])
    expect(state.rows.get(redraw.id)).toMatchObject({ status: 'queued', attempts: 0, errorCode: null })
    expect(state.rows.get(poll.id)).toMatchObject({ status: 'awaiting', attempts: 0, errorCode: null, requestId: 'fal-request' })
    expect(state.rows.get(review.id)).toMatchObject({ status: 'needs_review', errorCode: 'submission_unknown', attempts: 5 })
    expect(state.rows.get(custom.id)).toMatchObject({ status: 'failed', attempts: 5 })
    expect(state.rows.get(ready.id)!.status).toBe('ready')
    expect(retries(redraw.id)).toBe(1)
    expect(retries(poll.id)).toBe(0)
    expect(state.skills.get('skill-1')!.avatarStatus).toBe('pending')
  })

  it('a re-run is a no-op and never charges twice', async () => {
    const redraw = seed()
    await run(['retry', '--apply', '--task', redraw.id])
    const again = await run(['retry', '--apply', '--task', redraw.id])
    expect(again.tasks[0]).toMatchObject({ outcome: 'not_failed', status: 'queued' })
    expect(retries(redraw.id)).toBe(1)
  })

  it('a full day refuses the redraw with the task unchanged and no ledger row; free continuations still go', async () => {
    fillToday(3)
    const redraw = seed()
    const poll = seed({ requestId: 'fal-request' })
    const result = await run(['retry', '--apply', '--task', redraw.id, '--task', poll.id])
    expect(result.tasks.map(row => row.outcome)).toEqual(['quota_full', 'retried'])
    expect(state.rows.get(redraw.id)).toMatchObject({ status: 'failed', attempts: 5, errorCode: 'upstream_unavailable' })
    expect(retries(redraw.id)).toBe(0)
  })

  it('--all-failed selects only failed tasks', async () => {
    const failedA = seed(), failedB = seed({ errorCode: 'invalid_drawing_prompt' })
    seed({ status: 'needs_review' }); seed({ status: 'queued', errorCode: null }); seed({ status: 'ready', errorCode: null })
    const preview = await run(['retry', '--all-failed'])
    expect(preview.tasks.map(row => row.task).sort()).toEqual([failedA.id, failedB.id].sort())
    expect(state.writes).toBe(0)
    const applied = await run(['retry', '--all-failed', '--apply'])
    expect(applied.tasks.every(row => row.outcome === 'retried')).toBe(true)
    expect([...state.rows.values()].filter(row => row.status === 'needs_review')).toHaveLength(1)
  })

  it('refuses --apply while generation is disabled (preview still works)', async () => {
    const redraw = seed()
    state.config.SKILL_AVATARS_ENABLED = false
    await expect(run(['retry', '--apply', '--task', redraw.id])).rejects.toMatchObject({ statusCode: 503 })
    expect(state.writes).toBe(0)
    await expect(run(['retry', '--task', redraw.id])).resolves.toMatchObject({ dryRun: true })
  })
})
