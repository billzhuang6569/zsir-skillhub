vi.mock('./avatar-model.js', async (original) => ({ ...await original<typeof import('./avatar-model.js')>(), mirrorSkillAvatar: vi.fn().mockResolvedValue('mirrored-job') }))
import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import type { SkillAvatar } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SKILL_ART_FIXED_STYLE } from './skill-avatar-prompt.js'

/**
 * #235 bounded-concurrency worker against a small stateful fake of skill_avatars. The fake's
 * updateMany is check-and-set in one synchronous step, like a row-locked UPDATE … WHERE, so
 * interleaved claimers behave as they would on PostgreSQL (the PG test checks the real thing).
 */
type Row = SkillAvatar
const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(), config: { SKILL_AVATARS_ENABLED: true, SKILL_AVATAR_WORKER_CONCURRENCY: 4, SKILL_AVATAR_GENERATE_CONCURRENCY: 2, SKILL_AVATAR_DAILY_LIMIT: 200 },
  draft: vi.fn(), submit: vi.fn(), poll: vi.fn(),
}))
type Where = Record<string, unknown>
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Where[]).some(branch => matches(row, branch))
    const actual = (row as unknown as Record<string, unknown>)[key]
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      const filter = value as { in?: unknown[]; lte?: Date; lt?: Date; gte?: Date }
      if (filter.in) return filter.in.includes(actual)
      if (filter.lte) return actual instanceof Date && actual <= filter.lte
      if (filter.lt) return actual instanceof Date && actual < filter.lt
      if (filter.gte) return actual instanceof Date && actual >= filter.gte
    }
    return value === null ? actual === null : actual === value
  })
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const fake = vi.hoisted(() => ({}) as Record<string, unknown>)
Object.assign(fake, {
  skillAvatar: {
    findMany: async (args: { where: Where; take: number }): Promise<Array<{ id: string; ownerId: string }>> => {
      await tick()
      return [...state.rows.values()].filter(row => matches(row, args.where))
        .sort((left, right) => left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime() || left.createdAt.getTime() - right.createdAt.getTime())
        .slice(0, args.take).map(row => ({ id: row.id, ownerId: row.ownerId }))
    },
    groupBy: async (args: { where: { ownerId: { in: string[] }; leaseUntil: { gte: Date } } }): Promise<Array<{ ownerId: string; _count: { _all: number } }>> => {
      await tick()
      const counts = new Map<string, number>()
      for (const row of state.rows.values()) {
        if (args.where.ownerId.in.includes(row.ownerId) && row.leaseUntil && row.leaseUntil >= args.where.leaseUntil.gte) counts.set(row.ownerId, (counts.get(row.ownerId) ?? 0) + 1)
      }
      return [...counts].map(([ownerId, count]) => ({ ownerId, _count: { _all: count } }))
    },
    updateMany: async (args: { where: Where; data: Record<string, unknown> }): Promise<{ count: number }> => {
      await tick()
      let count = 0
      for (const row of state.rows.values()) {
        if (!matches(row, args.where)) continue
        for (const [key, value] of Object.entries(args.data)) {
          const target = row as unknown as Record<string, unknown>
          target[key] = value && typeof value === 'object' && 'increment' in value ? Number(target[key]) + (value as { increment: number }).increment : value
        }
        count += 1
      }
      return { count }
    },
    findFirst: async (args: { where: Where }): Promise<Row | null> => { await tick(); const row = [...state.rows.values()].find(item => matches(item, args.where)); return row ? { ...row } : null },
    findUnique: async (args: { where: { id: string } }): Promise<Row | null> => { const row = state.rows.get(args.where.id); return row ? { ...row } : null },
    count: async (args: { where: Where }): Promise<number> => [...state.rows.values()].filter(row => matches(row, args.where)).length,
  },
  skill: { findFirst: async (): Promise<{ id: string }> => ({ id: 'skill' }), updateMany: async (): Promise<{ count: number }> => ({ count: 1 }) },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(fake),
})
vi.mock('../db.js', () => ({ db: fake }))
vi.mock('../config.js', () => ({ config: state.config }))
vi.mock('../routes/skills.js', () => ({ requestConfiguredAiDraft: state.draft }))
vi.mock('./fal.js', async (original) => ({ ...await original<typeof import('./fal.js')>(), submitFalAvatar: state.submit, pollFalAvatar: state.poll, downloadFalAvatar: vi.fn() }))
vi.mock('./media.js', () => ({ uploadMedia: vi.fn(), publicImageUrl: (url: string): string => url }))

import { AVATAR_LANES, claimAvatar, createAvatarWorkerPool, runClaimedAvatar } from './skill-avatars.js'

const logger = { warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger & { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> }
let clock = 0
function seed(fields: Partial<Row> = {}): Row {
  const created = new Date(Date.now() - 3_600_000 + (clock += 1_000))
  const row = { id: randomUUID(), ownerId: 'owner-a', localSkillId: null, skillId: null, input: { name: 'n', description: 'd', scenarios: [] }, inputFingerprint: 'fp', promptVersion: 'v1',
    prompt: null, status: 'queued', requestId: null, submittedAt: null, imageUrl: null, imageData: null, imageSha256: null, assetId: null, url: null, errorCode: null,
    attempts: 0, nextAttemptAt: created, leaseToken: null, leaseUntil: null, source: 'generated', customAssetId: null, customUrl: null, customUpdatedAt: null,
    queuedAt: created, createdAt: created, updatedAt: created, ...fields } as Row
  state.rows.set(row.id, row)
  return row
}
type Deferred = { promise: Promise<void>; resolve: () => void }
const deferred = (): Deferred => { let resolve = (): void => undefined; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const drawing = 'A square illustration of a vermilion ribbon gathering mint leaves into a neat bundle. '.repeat(4) + '\n\n' + SKILL_ART_FIXED_STYLE

beforeEach(() => {
  state.rows.clear(); vi.clearAllMocks()
  state.config.SKILL_AVATARS_ENABLED = true
  state.draft.mockResolvedValue(drawing)
})

describe('bounded concurrency with a smaller generate lane', () => {
  it('runs at most `total` steps, at most `generate` of them generating; the rest wait and start as slots free', async () => {
    for (let index = 0; index < 5; index += 1) seed({ status: 'queued' })
    for (let index = 0; index < 5; index += 1) seed({ status: 'awaiting', requestId: `r${index}` })
    const gates: Deferred[] = []
    const started: string[] = []
    const run = async (avatar: SkillAvatar): Promise<void> => {
      started.push(avatar.status); const gate = deferred(); gates.push(gate); await gate.promise
      state.rows.get(avatar.id)!.status = 'ready'; state.rows.get(avatar.id)!.leaseToken = null; state.rows.get(avatar.id)!.leaseUntil = null
    }
    const pool = createAvatarWorkerPool(logger, { total: 3, generate: 2 }, claimAvatar, run)
    await pool.fill()
    expect(pool.inFlight()).toEqual({ generate: 2, deliver: 1 })
    expect(started).toHaveLength(3)
    // Queued work is waiting, not dropped.
    expect([...state.rows.values()].filter(row => row.leaseToken === null && row.status !== 'ready')).toHaveLength(7)
    gates[0]!.resolve()
    await vi.waitFor(() => expect(started).toHaveLength(4))
    const inFlight = pool.inFlight()
    expect(inFlight.generate + inFlight.deliver).toBe(3)
    expect(inFlight.generate).toBeLessThanOrEqual(2)
    // Keep finishing steps: every queued task gets a slot without another tick, never more than 3 at once.
    let peak = 0
    await vi.waitFor(() => {
      const now = pool.inFlight(); peak = Math.max(peak, now.generate + now.deliver)
      expect(now.generate).toBeLessThanOrEqual(2)
      gates.forEach(gate => gate.resolve())
      expect(started).toHaveLength(10)
    }, { timeout: 3_000, interval: 5 })
    gates.forEach(gate => gate.resolve())
    await pool.stop()
    expect(peak).toBeLessThanOrEqual(3)
    expect(started).toHaveLength(10)
    expect([...state.rows.values()].every(row => row.status === 'ready')).toBe(true)
  })

  it('a full generate lane does not block delivery, and delivery does not block generation', async () => {
    for (let index = 0; index < 4; index += 1) seed({ status: 'queued' })
    seed({ status: 'transferring', imageUrl: 'https://fal.example/a.jpg' })
    const lanes: string[] = []
    const run = async (avatar: SkillAvatar): Promise<void> => { lanes.push(avatar.status); await new Promise(() => undefined) }
    const pool = createAvatarWorkerPool(logger, { total: 4, generate: 2 }, claimAvatar, run)
    await pool.fill()
    expect(lanes.filter(status => status === 'queued')).toHaveLength(2)
    expect(lanes).toContain('transferring')
    expect(pool.inFlight()).toEqual({ generate: 2, deliver: 1 })
  })
})

describe('claiming is exclusive', () => {
  it('concurrent claimers over one batch claim every task exactly once', async () => {
    const tasks = Array.from({ length: 6 }, () => seed({ status: 'queued' }))
    const claims = await Promise.all(Array.from({ length: 20 }, () => claimAvatar(AVATAR_LANES.generate)))
    const ids = claims.flatMap(avatar => avatar ? [avatar.id] : [])
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(ids)).toEqual(new Set(tasks.map(task => task.id)))
    for (const avatar of claims) if (avatar) expect(state.rows.get(avatar.id)!.leaseToken).toBe(avatar.leaseToken)
    // A live lease is never claimable again; an expired one is (restart recovery).
    expect(await claimAvatar(AVATAR_LANES.generate)).toBeNull()
    const lost = tasks[0]!
    state.rows.get(lost.id)!.leaseUntil = new Date(Date.now() - 1)
    const recovered = await claimAvatar(AVATAR_LANES.generate)
    expect(recovered?.id).toBe(lost.id)
    expect(recovered?.leaseToken).not.toBe(claims.find(avatar => avatar?.id === lost.id)?.leaseToken)
  })

  it('FAL is submitted once even with every slot and repeated ticks on one task, and a step cut off mid-submit is quarantined, never resubmitted', async () => {
    const task = seed({ status: 'queued' })
    let release = (): void => undefined
    state.submit.mockImplementation(() => new Promise<string>(done => { release = () => done('fal-request-1') }))
    const pool = createAvatarWorkerPool(logger, { total: 4, generate: 4 })
    await Promise.all([pool.fill(), pool.fill(), pool.tick(), pool.fill()])
    await vi.waitFor(() => expect(state.submit).toHaveBeenCalledTimes(1))
    await pool.fill(); await pool.tick()
    expect(state.submit).toHaveBeenCalledTimes(1)
    release()
    await pool.stop()
    expect(state.rows.get(task.id)).toMatchObject({ status: 'awaiting', requestId: 'fal-request-1', leaseToken: null })
    // A crash after the intent was recorded: the lease expires and the next claimer quarantines it.
    const crashed = seed({ status: 'submitting', prompt: 'p', submittedAt: new Date(), leaseToken: 'dead-process', leaseUntil: new Date(Date.now() - 1) })
    const claimed = await claimAvatar(AVATAR_LANES.generate)
    expect(claimed?.id).toBe(crashed.id)
    await runClaimedAvatar(claimed!, logger)
    expect(state.rows.get(crashed.id)).toMatchObject({ status: 'needs_review', errorCode: 'submission_unknown' })
    expect(state.submit).toHaveBeenCalledTimes(1)
  })

  it('retries keep their backoff: a transient prompt failure is released with a later nextAttemptAt and is not reclaimable early', async () => {
    const task = seed({ status: 'queued' })
    state.draft.mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
    const claimed = await claimAvatar()
    await runClaimedAvatar(claimed!, logger)
    const row = state.rows.get(task.id)!
    expect(row).toMatchObject({ attempts: 1, errorCode: 'prompt_timeout', leaseToken: null })
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())
    expect(await claimAvatar()).toBeNull()
    expect(state.submit).not.toHaveBeenCalled()
  })
})

describe('#238 an AI guard refusal is a scheduled wait for the avatar, never a failure', () => {
  it('asks for background priority, and on busy / per-minute / daily refusals keeps attempts, stays due later, never fails or submits', async () => {
    const { AiRequestGuardError } = await import('../utils/ai-request-guard.js')
    const task = seed({ status: 'queued', attempts: 3 })
    const refusals = [new AiRequestGuardError('AI analysis is busy', 5, 'concurrency'), new AiRequestGuardError('AI analysis rate limit exceeded', 40, 'per_minute'),
      new AiRequestGuardError('AI analysis daily quota exhausted', 3_600, 'daily')]
    for (const [round, refusal] of refusals.entries()) {
      state.draft.mockRejectedValueOnce(refusal)
      state.rows.get(task.id)!.nextAttemptAt = new Date(Date.now() - 1)
      const claimed = await claimAvatar()
      expect(claimed?.id).toBe(task.id)
      const before = Date.now()
      await runClaimedAvatar(claimed!, logger)
      const row = state.rows.get(task.id)!
      expect(state.draft.mock.calls[round]![4]).toBe('background')
      expect(row).toMatchObject({ attempts: 3, errorCode: `ai_guard_${refusal.reason}`, leaseToken: null, leaseUntil: null })
      expect(['queued', 'prompting']).toContain(row.status)
      // Due again after max(15 s, Retry-After); not claimable before that.
      expect(row.nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(Math.max(15_000, refusal.retryAfterSeconds * 1_000) - 50)
      expect(row.nextAttemptAt.getTime() - before).toBeLessThanOrEqual(Math.max(15_000, refusal.retryAfterSeconds * 1_000) + 1_000)
      expect(await claimAvatar()).toBeNull()
    }
    expect(state.submit).not.toHaveBeenCalled()
    // The worker never writes the #221 ledger: this fake has no attempt table, and nothing tried to use one.
    expect((fake as { skillAvatarGenerationAttempt?: unknown }).skillAvatarGenerationAttempt).toBeUndefined()
    // After the waits the task still generates normally, with its retry budget untouched.
    state.rows.get(task.id)!.nextAttemptAt = new Date(Date.now() - 1)
    state.submit.mockResolvedValueOnce('fal-after-wait')
    await runClaimedAvatar((await claimAvatar())!, logger)
    expect(state.rows.get(task.id)).toMatchObject({ status: 'awaiting', requestId: 'fal-after-wait', attempts: 0 })
  })
})

describe('fairness between owners', () => {
  it('another owner\'s single newer task goes before a bulk import\'s next task', async () => {
    const bulk = Array.from({ length: 10 }, () => seed({ ownerId: 'bulk' }))
    const single = seed({ ownerId: 'single' })
    const first = await claimAvatar()
    expect(first?.id).toBe(bulk[0]!.id) // nobody busy yet: the earliest due task
    const second = await claimAvatar()
    expect(second?.id).toBe(single.id) // bulk now has one in flight; single has none
    const third = await claimAvatar()
    expect(third?.ownerId).toBe('bulk')
  })

  it('every owner is served when slots rotate', async () => {
    for (const owner of ['a', 'b', 'c']) for (let index = 0; index < 4; index += 1) seed({ ownerId: owner })
    const firstRound = await Promise.all([claimAvatar(), claimAvatar(), claimAvatar()])
    expect(new Set(firstRound.map(avatar => avatar?.ownerId))).toEqual(new Set(['a', 'b', 'c']))
  })
})

describe('stop and observability', () => {
  it('stop claims nothing new and waits for running steps; aggregate logs carry counts only', async () => {
    const tasks = Array.from({ length: 3 }, () => seed({ status: 'queued', prompt: null }))
    const gate = deferred()
    let runs = 0
    const pool = createAvatarWorkerPool(logger, { total: 1, generate: 1 }, claimAvatar, async () => { runs += 1; await gate.promise })
    await pool.tick()
    expect(runs).toBe(1)
    const stopping = pool.stop()
    gate.resolve()
    await stopping
    await pool.fill()
    expect(runs).toBe(1)
    const logged = JSON.stringify(logger.info.mock.calls)
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ inFlight: 1, generating: 1, delivering: 0, queuedGenerate: 2, queuedDeliver: 0, limit: 1, generateLimit: 1 }), 'Skill avatar worker')
    for (const task of tasks) expect(logged).not.toContain(task.id)
    expect(logged).not.toMatch(/https?:|prompt|owner/i)
  })

  it('does nothing while avatars are disabled', async () => {
    seed({ status: 'queued' })
    state.config.SKILL_AVATARS_ENABLED = false
    const run = vi.fn()
    const pool = createAvatarWorkerPool(logger, { total: 4, generate: 2 }, claimAvatar, run)
    await pool.tick()
    expect(run).not.toHaveBeenCalled()
  })
})
