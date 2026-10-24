/**
 * #238 incident reproduction: the real shared AI guard in routes/skills.ts, the real avatar
 * worker pool, and the real import analysis, with the AI provider mocked at fetch. An avatar
 * backlog keeps its generate lane full (even with the #235 default of 2 generate slots and
 * AI_MAX_CONCURRENT 2), yet a concurrent Skill import analysis is still admitted.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { SkillAvatar } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = vi.hoisted(() => ({
  AI_API_BASE_URL: 'https://provider.example' as string | undefined,
  AI_API_KEY: 'fixture-key-not-real' as string | undefined,
  AI_MODEL: 'fixture-model',
  AI_PROTOCOL: 'anthropic' as const,
  AI_MAX_TOKENS: 256,
  AI_RATE_LIMIT_PER_MINUTE: 60,
  AI_GLOBAL_DAILY_LIMIT: 1_000,
  AI_MAX_CONCURRENT: 2,
  AI_TIMEOUT_MS: 5_000,
  SKILL_AVATARS_ENABLED: true,
  SKILL_AVATAR_DAILY_LIMIT: 200,
  SKILL_MAX_PER_USER: 50,
}))
vi.mock('../db.js', () => ({ db: { skillAvatar: { count: async (): Promise<number> => 50 } } }))
vi.mock('../config.js', () => ({ config: mockConfig }))
vi.mock('../lib/mutation-lock.js', () => ({ lockSkillMutation: vi.fn(), lockSkillTeamMutation: vi.fn(), lockUserMutation: vi.fn() }))
vi.mock('../middleware/auth.js', () => ({ authMiddleware: vi.fn() }))

import { analyzeSkillWithAI, requestConfiguredAiDraft } from './skills.js'
import { createAvatarWorkerPool } from '../lib/skill-avatars.js'
import { AiRequestGuardError } from '../utils/ai-request-guard.js'

const fetchMock = vi.fn()
const pending: Array<() => void> = []
beforeEach(() => {
  fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { system?: string }
    if (body.system?.includes('Skill分析引擎')) {
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"displayName":"周报","description":"整理周报","category":"协作与办公","labels":[],"triggerScenarios":["写周报"]}' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    // Avatar drawing prompts hang until the test releases them: the backlog holds its slots.
    await new Promise<void>(resolve => pending.push(resolve))
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'draft' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => { pending.splice(0).forEach(release => release()); vi.unstubAllGlobals() })

describe('#238 an avatar backlog never takes the AI slot a user import needs', () => {
  it('background analysis shares the same reserved user slot as avatar prompts', async () => {
    fetchMock.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => pending.push(resolve))
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }))
    })
    const background = analyzeSkillWithAI('background', '# Background', 'background-owner', undefined, 'background')
    await vi.waitFor(() => expect(pending.length).toBe(1))
    await expect(analyzeSkillWithAI('next', '# Next', 'other-owner', undefined, 'background')).rejects.toMatchObject({ reason: 'concurrency' })
    await expect(analyzeSkillWithAI('manual', '# Manual', 'manual-owner')).resolves.toHaveProperty('source')
    pending.splice(0).forEach(release => release())
    await background
  })
  it('keeps one slot free: the import analysis is admitted while avatar prompts fill the background share', async () => {
    const logger = { warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
    let sequence = 0
    const refusals: unknown[] = []
    // A 50-task backlog in the generate lane, deliberately with the old default of 2 generate slots.
    // (A refused task waits for its backoff in production, so it is not claimed again here.)
    const claim = async (): Promise<SkillAvatar | null> => sequence >= 50 ? null : ({ id: `task-${sequence += 1}`, ownerId: 'bulk-owner', status: 'queued', leaseToken: 'lease' } as SkillAvatar)
    const run = async (avatar: SkillAvatar): Promise<void> => {
      await requestConfiguredAiDraft(`avatar:${avatar.ownerId}:${avatar.id}`, 'avatar system', JSON.stringify({ name: avatar.id }), 'text', 'background')
        .catch((error: unknown) => { refusals.push(error) })
    }
    const pool = createAvatarWorkerPool(logger, { total: 4, generate: 2 }, claim, run)
    void pool.fill()
    await vi.waitFor(() => expect(pending.length).toBe(1))
    // The second generate slot is refused by the guard (busy), not admitted.
    await vi.waitFor(() => expect(refusals.some(error => error instanceof AiRequestGuardError && error.reason === 'concurrency')).toBe(true))
    expect(pending.length).toBe(1)

    // Admitted (no AiRequestGuardError → no 429 for the import) and actually sent to the provider.
    // The fixture's profile has no catalog labels, so the analysis itself falls back; that is not under test here.
    const analysis = await analyzeSkillWithAI('weekly-report', '# Weekly report\n\nCollects the week.', 'import:user-1')
    expect(['ai', 'fallback']).toContain(analysis.source)
    expect(fetchMock.mock.calls.filter(([, init]) => String((init as { body: string }).body).includes('Skill分析引擎'))).toHaveLength(1)

    pending.splice(0).forEach(release => release())
    await pool.stop()
  })
})
