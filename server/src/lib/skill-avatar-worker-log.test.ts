vi.mock('./avatar-model.js', async (original) => ({ ...await original<typeof import('./avatar-model.js')>(), mirrorSkillAvatar: vi.fn().mockResolvedValue('mirrored-job') }))
import Fastify from 'fastify'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** #240: the worker's aggregate line must reach a production (`warn`) journal, rate limited. */
const state = vi.hoisted(() => ({ queued: 0, config: { SKILL_AVATARS_ENABLED: true } }))
vi.mock('../db.js', () => ({ db: { skillAvatar: { count: async (args: { where: { status: { in: string[] } } }): Promise<number> => args.where.status.in.includes('queued') ? state.queued : 0 } } }))
vi.mock('../config.js', () => ({ config: state.config }))
vi.mock('../routes/skills.js', () => ({ requestConfiguredAiDraft: vi.fn() }))
vi.mock('./media.js', () => ({ uploadMedia: vi.fn(), publicImageUrl: (url: string): string => url }))

import { AVATAR_WORKER_LOG_INTERVAL_MS, avatarWorkerLogger, createAvatarWorkerPool } from './skill-avatars.js'

beforeEach(() => { state.queued = 0; state.config.SKILL_AVATARS_ENABLED = true })

describe('the worker logs through its own info-level child logger', () => {
  it('emits info lines while the server logger stays at warn for everything else', async () => {
    const lines: Array<Record<string, unknown>> = []
    const app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => { lines.push(JSON.parse(line) as Record<string, unknown>) } } } })
    app.log.info('server info stays filtered')
    const worker = avatarWorkerLogger(app.log)
    worker.info({ inFlight: 1 }, 'Skill avatar worker')
    worker.warn('Skill avatar worker step unavailable')
    expect(app.log.level).toBe('warn')
    expect(worker.level).toBe('info')
    expect(lines.map(line => [line.level, line.msg, line.component])).toEqual([
      [30, 'Skill avatar worker', 'skill-avatar-worker'],
      [40, 'Skill avatar worker step unavailable', 'skill-avatar-worker'],
    ])
    await app.close()
  })
})

describe('the aggregate line is rate limited', () => {
  it('writes changes at most once per interval, always writes the step back to idle, and starts silent', async () => {
    expect(AVATAR_WORKER_LOG_INTERVAL_MS).toBe(60_000)
    const info = vi.fn()
    const logger = { info, warn: vi.fn() } as unknown as FastifyBaseLogger
    let now = 1_000_000
    const pool = createAvatarWorkerPool(logger, { total: 4, generate: 1 }, async () => null, async () => undefined, () => now)
    const at = async (offsetMs: number, queued: number): Promise<void> => { now = 1_000_000 + offsetMs; state.queued = queued; await pool.tick() }
    const queuedLogged = (): number[] => info.mock.calls.map(([summary]) => (summary as { queuedGenerate: number }).queuedGenerate)

    await at(0, 0)
    expect(info).not.toHaveBeenCalled() // starts idle: nothing to say
    await at(5_000, 5)
    expect(queuedLogged()).toEqual([5])
    await at(10_000, 4) // changed, but within the interval
    await at(30_000, 3)
    expect(queuedLogged()).toEqual([5])
    await at(65_000, 3) // interval passed: the current state
    expect(queuedLogged()).toEqual([5, 3])
    await at(66_000, 0) // back to fully idle: written at once
    expect(queuedLogged()).toEqual([5, 3, 0])
    await at(67_000, 0) // unchanged
    await at(70_000, 2) // busy again, within the interval of the idle line
    expect(queuedLogged()).toEqual([5, 3, 0])
    await at(127_000, 2)
    expect(queuedLogged()).toEqual([5, 3, 0, 2])
    for (const [summary, message] of info.mock.calls) {
      expect(message).toBe('Skill avatar worker')
      expect(Object.keys(summary as object).sort()).toEqual(['delivering', 'generateLimit', 'generating', 'inFlight', 'limit', 'queuedDeliver', 'queuedGenerate'])
      expect(Object.values(summary as object).every(value => typeof value === 'number')).toBe(true)
    }
  })
})
