vi.mock('./avatar-model.js', async (original) => ({ ...await original<typeof import('./avatar-model.js')>(), mirrorSkillAvatar: vi.fn().mockResolvedValue('mirrored-job') }))
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillAvatar } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import { SKILL_AVATAR_SYSTEM, SKILL_ART_FIXED_STYLE, SKILL_AVATAR_CANVAS } from './skill-avatar-prompt.js'

const mock = vi.hoisted(() => ({
  skillAvatar: { findFirst: vi.fn(), findMany: vi.fn(), groupBy: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
  skill: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  skillAvatarAlias: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  skillAvatarGenerationAttempt: { count: vi.fn(), create: vi.fn() },
  libraryEntry: { findFirst: vi.fn(), findMany: vi.fn() },
  marketplaceListing: { findUnique: vi.fn() }, $transaction: vi.fn(), $queryRaw: vi.fn(),
  draft: vi.fn(), submit: vi.fn(), poll: vi.fn(), download: vi.fn(), upload: vi.fn(),
}))
vi.mock('../db.js', () => ({ db: mock }))
vi.mock('../config.js', () => ({ config: { SKILL_AVATARS_ENABLED: true, SKILL_MAX_PER_USER: 50, SKILL_AVATAR_DAILY_LIMIT: 200 } }))
vi.mock('../routes/skills.js', () => ({ requestConfiguredAiDraft: mock.draft }))
vi.mock('./mutation-lock.js', () => ({ lockUserMutation: vi.fn() }))
vi.mock('./fal.js', async (original) => ({ ...await original<typeof import('./fal.js')>(),
  submitFalAvatar: mock.submit, pollFalAvatar: mock.poll, downloadFalAvatar: mock.download }))
vi.mock('./media.js', () => ({ uploadMedia: mock.upload, publicImageUrl: (url: string): string => url }))

import { AiRequestGuardError } from '../utils/ai-request-guard.js'
import {
  AVATAR_BACKOFF_CAP_MS, AVATAR_MAX_ATTEMPTS, AVATAR_STEP_INTERVAL_MS, avatarDto, avatarStage, classifyAvatarFailure,
  AVATAR_IDENTITY_CONFLICT, bindCloudAvatarToEntry, continueCloudAvatar, ensureEnrichmentAvatar, hasEnrichmentAvatar, ensureSkillAvatar, nextAvatarAttemptAt, processAvatar, retryTarget, runAvatarWorkerOnce, sanitizeAvatarInput,
} from './skill-avatars.js'
import { FalError } from './fal.js'
import { config } from '../config.js'
import { avatarRegistrationLimiter } from './avatar-generation.js'
import { AiProviderHttpError, aiProviderHttpError } from '../utils/retry-after.js'
const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger
const task = (fields: Partial<SkillAvatar> = {}): SkillAvatar => ({
  id: '11111111-1111-4111-8111-111111111111', ownerId: 'owner', localSkillId: 'local-identity',
  skillId: null, input: { name: 'Research', description: 'Find and organize sources', scenarios: [] },
  inputFingerprint: 'input-hash', promptVersion: 'v1', prompt: null, status: 'queued',
  requestId: null, submittedAt: null, imageUrl: null, imageData: null, imageSha256: null,
  assetId: null, url: null, errorCode: null, attempts: 0, nextAttemptAt: new Date(),
  leaseToken: 'lease', leaseUntil: null, createdAt: new Date(), updatedAt: new Date(), ...fields,
})
const writes = (): Array<Record<string, unknown>> => mock.skillAvatar.updateMany.mock.calls.map(call => call[0].data as Record<string, unknown>)

beforeEach(() => {
  avatarRegistrationLimiter.clear('owner')
  vi.clearAllMocks()
  mock.$transaction.mockImplementation(async (fn: (db: typeof mock) => Promise<unknown>): Promise<unknown> => fn(mock))
  mock.skillAvatar.updateMany.mockResolvedValue({ count: 1 })
  mock.skillAvatar.findUnique.mockResolvedValue(null)
  mock.skillAvatar.update.mockImplementation(async (args: { where: { id: string }; data: Partial<SkillAvatar> }): Promise<SkillAvatar> => task({ id: args.where.id, ...args.data }))
  mock.skillAvatarAlias.findUnique.mockResolvedValue(null)
  mock.skillAvatarAlias.findMany.mockResolvedValue([])
  mock.skillAvatarAlias.create.mockResolvedValue(undefined)
  mock.libraryEntry.findFirst.mockResolvedValue(null)
  mock.libraryEntry.findMany.mockResolvedValue([])
  mock.skillAvatar.findFirst.mockResolvedValue(null)
  mock.skillAvatar.count.mockResolvedValue(0)
  // #235 claim: the due ids (one task), no owner busy; the claimed row is then read by findFirst.
  mock.skillAvatar.findMany.mockResolvedValue([{ id: '11111111-1111-4111-8111-111111111111', ownerId: 'owner' }])
  mock.skillAvatar.groupBy.mockResolvedValue([])
  mock.skillAvatarGenerationAttempt.count.mockResolvedValue(0)
  mock.skillAvatarGenerationAttempt.create.mockResolvedValue(undefined)
  mock.skillAvatar.create.mockImplementation(async (args: { data: Partial<SkillAvatar> }): Promise<SkillAvatar> => task(args.data))
  mock.marketplaceListing.findUnique.mockResolvedValue(null)
  mock.skill.findFirst.mockResolvedValue(null)
  vi.unstubAllGlobals()
})

describe('persistent Skill avatar generation', () => {
  it.each(['ready', 'failed', 'needs_review', 'cancelled', 'queued'])('enrichment preserves existing %s tasks without a new attempt', async status => {
    mock.skill.findFirst.mockResolvedValue({ id: 'cloud' })
    mock.skillAvatar.findUnique.mockResolvedValue(task({ skillId: 'cloud', status }))
    await ensureEnrichmentAvatar('owner', 'cloud')
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
    expect(mock.skillAvatarGenerationAttempt.create).not.toHaveBeenCalled()
  })
  it('enrichment finds proven entry/device aliases but ignores unrelated local tasks', async () => {
    mock.libraryEntry.findMany.mockResolvedValue([{ id: 'entry' }])
    mock.skillAvatarAlias.findUnique.mockResolvedValue({ avatar: task({ status: 'needs_review' }) })
    expect(await hasEnrichmentAvatar(mock as unknown as import('@prisma/client').Prisma.TransactionClient, 'owner', 'cloud')).toBe(true)
    mock.skillAvatarAlias.findUnique.mockResolvedValue(null)
    mock.skillAvatar.findFirst.mockResolvedValue(task({ status: 'ready' }))
    expect(await hasEnrichmentAvatar(mock as unknown as import('@prisma/client').Prisma.TransactionClient, 'owner', 'cloud')).toBe(false)
    mock.skill.findFirst.mockResolvedValue({ id: 'cloud', displayName: 'Cloud', triggerScenarios: [] })
    await ensureEnrichmentAvatar('owner', 'cloud')
    expect(mock.skillAvatar.create).toHaveBeenCalledOnce()
  })
  it('enrichment parks conflicting identities proven by the same account entry', async () => {
    mock.libraryEntry.findMany.mockResolvedValue([{ id: 'entry' }])
    mock.skillAvatarAlias.findUnique.mockResolvedValue({ avatar: task({ skillId: 'other-cloud' }) })
    await expect(hasEnrichmentAvatar(mock as unknown as import('@prisma/client').Prisma.TransactionClient, 'owner', 'cloud')).rejects.toMatchObject({ code: 'AVATAR_IDENTITY_CONFLICT' })
  })
  it('does not pay again for a device-first CLI Skill before its first LibraryEntry exists', async () => {
    const local = await ensureSkillAvatar({ ownerId: 'owner', localSkillId: 'device-first', input: { name: 'CLI', description: 'Original', scenarios: [] } })
    expect(mock.skillAvatar.create).toHaveBeenCalledOnce()
    expect(mock.skillAvatarGenerationAttempt.create).toHaveBeenCalledOnce()
    mock.skillAvatar.findFirst.mockResolvedValue(local)
    mock.libraryEntry.findMany.mockResolvedValue([])
    mock.skill.findFirst.mockResolvedValue({ id: 'cli-created', displayName: 'CLI', triggerScenarios: [] })
    await expect(ensureEnrichmentAvatar('owner', 'cli-created')).rejects.toMatchObject({ code: 'AVATAR_IDENTITY_CONFLICT' })
    expect(mock.skillAvatar.create).toHaveBeenCalledOnce()
    expect(mock.skillAvatarGenerationAttempt.create).toHaveBeenCalledOnce()
  })
  it('enrichment reuses quota accounting and analyzed cloud input', async () => {
    mock.skill.findFirst.mockResolvedValue({ id: 'cloud', displayName: 'Analyzed', description: 'New summary', triggerScenarios: [] })
    await ensureEnrichmentAvatar('owner', 'cloud')
    expect(mock.skillAvatar.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ input: { name: 'Analyzed', description: 'New summary', scenarios: [] } }) }))
    expect(mock.skillAvatarGenerationAttempt.create).toHaveBeenCalledOnce()
  })
  it('enrichment obeys the daily quota and does not enqueue when disabled', async () => {
    mock.skill.findFirst.mockResolvedValue({ id: 'cloud', displayName: 'Analyzed', triggerScenarios: [] })
    mock.skillAvatarGenerationAttempt.count.mockResolvedValue(200)
    await expect(ensureEnrichmentAvatar('owner', 'cloud')).rejects.toMatchObject({ statusCode: 429, code: 'AVATAR_DAILY_QUOTA' })
    expect(mock.skillAvatarGenerationAttempt.create).not.toHaveBeenCalled()
    config.SKILL_AVATARS_ENABLED = false
    try {
      mock.skillAvatar.create.mockClear()
      await ensureEnrichmentAvatar('owner', 'cloud')
      expect(mock.skillAvatar.create).not.toHaveBeenCalled()
    } finally { config.SKILL_AVATARS_ENABLED = true }
  })
  it('background registration shares the API hourly allowance', async () => {
    mock.skill.findFirst.mockResolvedValue({ id: 'cloud', displayName: 'Analyzed', triggerScenarios: [] })
    for (let index = 0; index < 60; index += 1) avatarRegistrationLimiter.consume('owner', 60, 3600_000)
    await expect(ensureEnrichmentAvatar('owner', 'cloud')).rejects.toMatchObject({ statusCode: 429, code: 'AVATAR_RATE_LIMITED' })
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
  })
  it('import only binds existing identities and never creates a task before analysis', async () => {
    mock.skill.findFirst.mockResolvedValue({ id: 'cloud', displayName: 'Original', triggerScenarios: [] })
    await continueCloudAvatar('owner', 'cloud', 'entry')
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
    expect(mock.skillAvatarGenerationAttempt.create).not.toHaveBeenCalled()
  })
  it('import continuation projects the existing image onto the legacy cloud row', async () => {
    mock.skill.findFirst.mockResolvedValue({ id: 'cloud', displayName: 'Original', triggerScenarios: [] })
    mock.skillAvatar.findUnique.mockResolvedValue(task({ localSkillId: 'entry', skillId: 'cloud', status: 'ready', url: 'https://images.example.test/original.jpg' }))
    await continueCloudAvatar('owner', 'cloud', 'entry')
    expect(mock.skill.update).toHaveBeenCalledWith({ where: { id: 'cloud' }, data: { avatarUrl: 'https://images.example.test/original.jpg', avatarStatus: 'ready' } })
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
  })
  it('recovers saved assets and never requeues consumed submit rights without evidence', () => {
    const failed = task({ status: 'failed', leaseToken: null, submittedAt: new Date() })
    expect(retryTarget(failed)).toBeNull()
    expect(retryTarget({ ...failed, assetId: 'accepted', url: 'https://picem-media.whatonearth.work/accepted.jpg' })).toBe('transferring')
    expect(retryTarget({ ...failed, requestId: 'accepted-request' })).toBe('awaiting')
    expect(retryTarget({ ...failed, submittedAt: null })).toBe('queued')
  })
  it('redacts secrets, personal paths, email and links before persisting input', () => {
    const input = sanitizeAvatarInput({ name: 'Sources', description: 'API_KEY=actual-private-key-value contact person@test.invalid /Users/private/docs https://secret.test/query?token=123', scenarios: [] })
    expect(input.description).not.toContain('actual-private')
    expect(input.description).not.toContain('person@test')
    expect(input.description).not.toContain('/Users/')
    expect(input.description).not.toContain('https://')
  })
  it('keeps an existing avatar stable even when the description changes', async () => {
    mock.skillAvatar.findUnique.mockResolvedValue(task({ status: 'ready', url: 'https://picem-media.whatonearth.work/avatar.jpg' }))
    mock.skillAvatar.update.mockResolvedValue(task({ status: 'ready' }))
    await ensureSkillAvatar({ ownerId: 'owner', localSkillId: 'local-identity', input: { name: 'New', description: 'Changed', scenarios: [] } })
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
    expect(mock.draft).not.toHaveBeenCalled()
    // Nothing to change: no write at all, and never the input.
    expect(mock.skillAvatar.update).not.toHaveBeenCalled()
  })
  it('uses the approved listing snapshot and refuses cross-owner cloud identity', async () => {
    mock.skill.findFirst.mockResolvedValueOnce({ displayName: 'private draft', description: 'private change', triggerScenarios: [] })
    mock.marketplaceListing.findUnique.mockResolvedValue({ withdrawnAt: null, submission: {
      status: 'approved', displayName: 'Reviewed', description: 'Reviewed introduction', triggerScenarios: ['public scenario'],
    } })
    await ensureSkillAvatar({ ownerId: 'owner', skillId: 'cloud' })
    expect(mock.skillAvatar.create.mock.calls[0][0].data.input.description).toBe('Reviewed introduction')
    await expect(ensureSkillAvatar({ ownerId: 'other', skillId: 'cloud' })).rejects.toMatchObject({ statusCode: 404 })
  })
  it('quarantines a restart after submit intent without issuing another paid request', async () => {
    await processAvatar(task({ status: 'submitting' }))
    expect(writes()).toContainEqual({ status: 'needs_review', errorCode: 'submission_unknown' })
    expect(mock.submit).not.toHaveBeenCalled()
  })
  it('retries an unavailable text response without submitting to FAL', async () => {
    mock.draft.mockResolvedValue(null)
    await expect(processAvatar(task())).rejects.toMatchObject({ code: 'drawing_prompt_unavailable' })
    expect(mock.submit).not.toHaveBeenCalled()
  })
  it('persists submit intent before calling FAL and quarantines an unknown response', async () => {
    const style = SKILL_ART_FIXED_STYLE
    mock.draft.mockResolvedValue('A square illustration with a vermilion ribbon gathering mint leaves.\n\n' + style)
    mock.submit.mockRejectedValue(new Error('timeout'))
    await processAvatar(task())
    const intent = mock.skillAvatar.updateMany.mock.calls.findIndex(call => call[0].data.status === 'submitting')
    expect(mock.skillAvatar.updateMany.mock.invocationCallOrder[intent]).toBeLessThan(mock.submit.mock.invocationCallOrder[0])
    expect(writes()).toContainEqual({ status: 'needs_review', errorCode: 'submission_unknown' })
    expect(mock.draft.mock.calls[0][3]).toBe('text')
    expect(SKILL_AVATAR_SYSTEM).toContain(SKILL_ART_FIXED_STYLE)
    expect(mock.submit.mock.calls[0][0]).toContain(SKILL_AVATAR_CANVAS)
  })
  it('resumes the persisted FAL request and never submits while polling', async () => {
    mock.poll.mockResolvedValue('https://v3.fal.media/files/avatar.jpg')
    await processAvatar(task({ status: 'awaiting', requestId: 'known-request' }))
    expect(mock.poll).toHaveBeenCalledWith('known-request')
    expect(mock.submit).not.toHaveBeenCalled()
    expect(writes()).toContainEqual({ imageUrl: 'https://v3.fal.media/files/avatar.jpg', status: 'transferring', attempts: 0, errorCode: null })
  })
  it('retries Picem from durable JPEG bytes and marks ready only after a usable link', async () => {
    const url = 'https://picem-media.whatonearth.work/avatar.jpg'
    mock.upload.mockResolvedValue({ assetId: 'ast_test', url })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { headers: { 'content-type': 'image/jpeg' } })))
    mock.skillAvatar.findUnique.mockResolvedValue({ skillId: 'bound-during-transfer' })
    await processAvatar(task({ status: 'transferring', imageData: Buffer.from('saved-image'), imageUrl: 'https://v3.fal.media/files/avatar.jpg' }))
    expect(mock.download).not.toHaveBeenCalled()
    expect(mock.submit).not.toHaveBeenCalled()
    expect(writes().at(-1)).toMatchObject({ status: 'ready', assetId: 'ast_test', url, imageData: null })
    expect(mock.skill.updateMany.mock.calls.at(-1)?.[0].where.id).toBe('bound-during-transfer')
  })
  it('retains bytes on Picem failure and rejects a lost database lease', async () => {
    mock.upload.mockRejectedValue(new Error('picem down'))
    await expect(processAvatar(task({ status: 'transferring', imageData: Buffer.from('saved') }))).rejects.toThrow()
    expect(writes().some(write => write.status === 'ready')).toBe(false)
    mock.skillAvatar.updateMany.mockResolvedValue({ count: 0 })
    await processAvatar(task())
    expect(mock.draft).not.toHaveBeenCalled()
  })
  it('keeps a builtin relative URL and finishes without a CDN request', async (): Promise<void> => {
    const previous = config.SKILLHUB_PROFILE
    config.SKILLHUB_PROFILE = 'selfhost'
    const url = `/media/aa/${'a'.repeat(64)}.jpg`
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    mock.upload.mockResolvedValue({ assetId: 'a'.repeat(64), url })
    try {
      await processAvatar(task({ status: 'transferring', imageData: Buffer.from('saved') }))
      expect(writes().at(-1)).toMatchObject({ status: 'ready', url, imageData: null })
      expect(fetch).not.toHaveBeenCalled()
    } finally { config.SKILLHUB_PROFILE = previous }
  })
  it('resumes an accepted Picem asset after a CDN or final lease failure', async () => {
    const url = 'https://picem-media.whatonearth.work/avatar.jpg'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { headers: { 'content-type': 'image/jpeg' } })))
    mock.skillAvatar.updateMany.mockResolvedValue({ count: 0 })
    await processAvatar(task({ status: 'transferring', assetId: 'ast_accepted', url, imageData: Buffer.from('saved') }))
    expect(mock.upload).not.toHaveBeenCalled()
    expect(mock.download).not.toHaveBeenCalled()
    expect(writes()).toContainEqual(expect.objectContaining({ status: 'ready', assetId: 'ast_accepted', url }))
  })
  it('allows only the winning atomic claimant to process a task', async () => {
    mock.skillAvatar.findFirst.mockResolvedValue(task({ status: 'submitting' }))
    mock.skillAvatar.updateMany.mockResolvedValue({ count: 0 })
    await runAvatarWorkerOnce(logger)
    expect(mock.skillAvatar.updateMany).toHaveBeenCalledTimes(1)
    expect(mock.submit).not.toHaveBeenCalled()
  })
  it('never exposes internal prompts, provider URLs or error details in DTOs', () => {
    expect(avatarDto(task({ status: 'awaiting', url: 'temporary' }))).toEqual({ avatarStatus: 'pending', avatarUrl: null, avatarSource: 'generated' })
    expect(avatarDto(task({ status: 'needs_review' }))).toEqual({ avatarStatus: 'needs_review', avatarUrl: null, avatarSource: 'generated' })
  })

})

describe('avatar failure classification and scheduling', () => {
  const now = new Date('2026-10-10T03:37:00.000Z')
  it('attributes limiter refusals to the window that fired and keeps their Retry-After', () => {
    expect(classifyAvatarFailure(new AiRequestGuardError('rate', 42, 'per_minute'), 'prompting'))
      .toEqual({ code: 'ai_guard_per_minute', stage: 'prompting', kind: 'quota', retryAfterMs: 42_000 })
    expect(classifyAvatarFailure(new AiRequestGuardError('daily', 40_000, 'daily'), 'prompting'))
      .toMatchObject({ code: 'ai_guard_daily', kind: 'quota', retryAfterMs: 40_000_000 })
    expect(classifyAvatarFailure(new AiRequestGuardError('busy', 5, 'concurrency'), 'prompting'))
      .toMatchObject({ code: 'ai_guard_concurrency', kind: 'quota', retryAfterMs: 5_000 })
  })
  it('names the stage and mechanism instead of one generic upstream code', () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    expect(classifyAvatarFailure(timeout, 'prompting')).toMatchObject({ code: 'prompt_timeout', kind: 'transient' })
    expect(classifyAvatarFailure(new Error('AI provider returned HTTP 503'), 'prompting')).toMatchObject({ code: 'prompt_http_503', kind: 'transient', retryAfterMs: null })
    const limited = Object.assign(new Error('429 Too Many Requests'), { status: 429, headers: { 'retry-after': '120' } })
    expect(classifyAvatarFailure(limited, 'prompting')).toMatchObject({ code: 'prompt_http_429', kind: 'transient', retryAfterMs: 120_000 })
    const network = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    expect(classifyAvatarFailure(network, 'awaiting')).toMatchObject({ code: 'fal_poll_network', stage: 'awaiting', kind: 'transient' })
    expect(classifyAvatarFailure(new Error('weird'), 'transferring')).toMatchObject({ code: 'transfer_failed', stage: 'transferring', kind: 'transient' })
    expect(classifyAvatarFailure('not an error', 'prompting')).toMatchObject({ code: 'prompt_failed', kind: 'transient' })
    expect(classifyAvatarFailure(new FalError('fal_http_503'), 'awaiting')).toMatchObject({ code: 'fal_http_503', kind: 'transient' })
    expect(classifyAvatarFailure(new FalError('invalid_drawing_prompt'), 'prompting')).toMatchObject({ code: 'invalid_drawing_prompt', kind: 'terminal' })
    expect(classifyAvatarFailure(new FalError('fal_generation_failed'), 'awaiting')).toMatchObject({ kind: 'terminal' })
    expect(classifyAvatarFailure(new FalError('drawing_prompt_unavailable'), 'prompting')).toMatchObject({ kind: 'transient' })
    expect(avatarStage('queued')).toBe('prompting'); expect(avatarStage('prompting')).toBe('prompting')
    expect(avatarStage('awaiting')).toBe('awaiting'); expect(avatarStage('transferring')).toBe('transferring')
  })
  it('honours quota waits and upstream Retry-After as floors and caps only the exponential part', () => {
    expect(nextAvatarAttemptAt(now, null, 0).getTime() - now.getTime()).toBe(AVATAR_STEP_INTERVAL_MS)
    const daily = classifyAvatarFailure(new AiRequestGuardError('daily', 40_000, 'daily'), 'prompting')
    expect(nextAvatarAttemptAt(now, daily, 0).getTime() - now.getTime()).toBe(40_000_000) // hours, not clamped, not midnight
    const busy = classifyAvatarFailure(new AiRequestGuardError('busy', 5, 'concurrency'), 'prompting')
    expect(nextAvatarAttemptAt(now, busy, 0).getTime() - now.getTime()).toBe(AVATAR_STEP_INTERVAL_MS) // never below the step cadence
    const transient = classifyAvatarFailure(new Error('AI provider returned HTTP 503'), 'prompting')
    expect(nextAvatarAttemptAt(now, transient, 1).getTime() - now.getTime()).toBe(15_000)
    expect(nextAvatarAttemptAt(now, transient, 2).getTime() - now.getTime()).toBe(30_000)
    expect(nextAvatarAttemptAt(now, transient, 4).getTime() - now.getTime()).toBe(120_000)
    expect(nextAvatarAttemptAt(now, transient, 40).getTime() - now.getTime()).toBe(AVATAR_BACKOFF_CAP_MS)
    const retryAfter = classifyAvatarFailure(Object.assign(new Error('x'), { status: 429, headers: { 'retry-after': '600' } }), 'prompting')
    expect(nextAvatarAttemptAt(now, retryAfter, 1).getTime() - now.getTime()).toBe(600_000)
  })
})

describe('worker scheduling under injected failures', () => {
  const claimed = (fields: Partial<SkillAvatar> = {}): void => {
    mock.skillAvatar.findFirst.mockResolvedValue(task(fields))
    mock.skillAvatar.updateMany.mockResolvedValue({ count: 1 })
  }
  /** Data written by the lease release, which is the only place that sets nextAttemptAt. */
  const release = (): Record<string, unknown> => {
    const call = mock.skillAvatar.updateMany.mock.calls.findLast(call => call[0].data?.leaseToken === null)
    expect(call).toBeDefined()
    return call![0].data as Record<string, unknown>
  }
  const waitMs = (): number => (release().nextAttemptAt as Date).getTime() - Date.now()

  it('treats a per-minute guard refusal as a wait: no attempt spent, Retry-After kept, task stays active', async () => {
    claimed({ status: 'queued', attempts: 3 })
    mock.draft.mockRejectedValue(new AiRequestGuardError('AI analysis rate limit exceeded', 47, 'per_minute'))
    await runAvatarWorkerOnce(logger)
    expect(mock.submit).not.toHaveBeenCalled()
    const failure = writes().find(write => write.errorCode === 'ai_guard_per_minute')
    expect(failure).toBeDefined()
    expect(failure).not.toHaveProperty('attempts')
    expect(failure).not.toHaveProperty('status')
    expect(waitMs()).toBeGreaterThanOrEqual(46_000)
    expect(waitMs()).toBeLessThanOrEqual(48_000)
  })
  it('terminates a depleted provider account on the first attempt and never submits to FAL', async () => {
    claimed({ status: 'queued', attempts: 0 })
    mock.draft.mockRejectedValue(new AiProviderHttpError('openai-responses', 403, null, 'insufficient_user_quota'))
    await runAvatarWorkerOnce(logger)
    expect(writes()).toContainEqual({ errorCode: 'prompt_insufficient_user_quota', attempts: { increment: 1 }, status: 'failed' })
    expect(mock.submit).not.toHaveBeenCalled()
    expect(release()).toMatchObject({ leaseToken: null, leaseUntil: null })
  })
  it('waits out the daily window from the guard instead of 15 seconds or midnight', async () => {
    claimed({ status: 'queued', attempts: 4 })
    mock.draft.mockRejectedValue(new AiRequestGuardError('AI analysis daily quota exhausted', 39_600, 'daily'))
    await runAvatarWorkerOnce(logger)
    expect(writes().some(write => write.status === 'failed')).toBe(false) // a wait never terminates the task
    expect(waitMs()).toBeGreaterThanOrEqual(39_599_000)
    expect(release()).toMatchObject({ leaseToken: null, leaseUntil: null })
  })
  it('floors a concurrency refusal at the step cadence', async () => {
    claimed({ status: 'queued' })
    mock.draft.mockRejectedValue(new AiRequestGuardError('AI analysis is busy', 5, 'concurrency'))
    await runAvatarWorkerOnce(logger)
    expect(writes()).toContainEqual({ errorCode: 'ai_guard_concurrency' })
    expect(waitMs()).toBeGreaterThanOrEqual(AVATAR_STEP_INTERVAL_MS - 1_000)
  })
  it('backs off exponentially on transient prompt failures and terminates on the fifth attempt', async () => {
    claimed({ status: 'queued', attempts: 1 })
    mock.draft.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
    await runAvatarWorkerOnce(logger)
    expect(writes()).toContainEqual({ errorCode: 'prompt_timeout', attempts: { increment: 1 } })
    expect(waitMs()).toBeGreaterThanOrEqual(29_000) // second attempt → 30 s
    claimed({ status: 'queued', attempts: AVATAR_MAX_ATTEMPTS - 1 })
    mock.draft.mockRejectedValue(new Error('AI provider returned HTTP 502'))
    await runAvatarWorkerOnce(logger)
    expect(writes()).toContainEqual({ errorCode: 'prompt_http_502', attempts: { increment: 1 }, status: 'failed' })
    expect(mock.submit).not.toHaveBeenCalled()
  })
  it('keeps an upstream Retry-After even when the backoff would be shorter', async () => {
    claimed({ status: 'queued' })
    mock.draft.mockRejectedValue(Object.assign(new Error('429'), { status: 429, headers: new Headers({ 'retry-after': '300' }) }))
    await runAvatarWorkerOnce(logger)
    expect(writes()).toContainEqual({ errorCode: 'prompt_http_429', attempts: { increment: 1 } })
    expect(waitMs()).toBeGreaterThanOrEqual(299_000)
  })
  it('fails invalid prompts immediately and names poll / transfer stage failures without re-submitting', async () => {
    const style = SKILL_ART_FIXED_STYLE
    claimed({ status: 'queued' })
    mock.draft.mockResolvedValue('短 ' + style)
    await runAvatarWorkerOnce(logger)
    expect(writes()).toContainEqual({ errorCode: 'invalid_drawing_prompt', attempts: { increment: 1 }, status: 'failed' })
    expect(mock.submit).not.toHaveBeenCalled()
    claimed({ status: 'awaiting', requestId: 'known-request' })
    mock.poll.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))
    await runAvatarWorkerOnce(logger)
    expect(writes()).toContainEqual({ errorCode: 'fal_poll_network', attempts: { increment: 1 } })
    expect(writes().some(write => 'requestId' in write)).toBe(false)
    claimed({ status: 'transferring', imageData: Buffer.from('saved') })
    mock.upload.mockRejectedValue(new Error('picem down'))
    await runAvatarWorkerOnce(logger)
    expect(writes()).toContainEqual({ errorCode: 'transfer_failed', attempts: { increment: 1 } })
    expect(mock.submit).not.toHaveBeenCalled()
    expect(writes().some(write => write.errorCode === 'upstream_unavailable')).toBe(false)
  })
  it('worker scheduling: honours Retry-After carried on adapter-shaped errors (adapter coverage lives in routes/ai-draft-retry-after.test.ts)', async () => {
    // Responses adapter: a 429 with delta-seconds reaches the worker as a floor.
    claimed({ status: 'queued' })
    mock.draft.mockRejectedValue(aiProviderHttpError('openai-responses', new Response(null, { status: 429, headers: { 'retry-after': '300' } })))
    await runAvatarWorkerOnce(logger)
    expect(writes()).toContainEqual({ errorCode: 'prompt_http_429', attempts: { increment: 1 } })
    expect(waitMs()).toBeGreaterThanOrEqual(299_000)
    // Anthropic adapter: an HTTP-date Retry-After is honoured too.
    claimed({ status: 'queued' })
    const at = new Date(Date.now() + 240_000).toUTCString()
    mock.draft.mockRejectedValue(aiProviderHttpError('anthropic', new Response(null, { status: 529, headers: { 'retry-after': at } })))
    await runAvatarWorkerOnce(logger)
    expect(writes()).toContainEqual({ errorCode: 'prompt_http_529', attempts: { increment: 1 } })
    expect(waitMs()).toBeGreaterThanOrEqual(236_000)
    // Malformed header: backoff only, never treated as zero wait.
    claimed({ status: 'queued' })
    mock.draft.mockRejectedValue(aiProviderHttpError('anthropic', new Response(null, { status: 503, headers: { 'retry-after': 'soon' } })))
    await runAvatarWorkerOnce(logger)
    expect(writes()).toContainEqual({ errorCode: 'prompt_http_503', attempts: { increment: 1 } })
    expect(waitMs()).toBeGreaterThanOrEqual(AVATAR_STEP_INTERVAL_MS - 1_000)
    // FAL polling: the FalError built from a 429 carries the wait; the accepted request is kept.
    claimed({ status: 'awaiting', requestId: 'known-request' })
    mock.poll.mockRejectedValue(new FalError('fal_http_429', 429, 600_000))
    await runAvatarWorkerOnce(logger)
    expect(writes()).toContainEqual({ errorCode: 'fal_http_429', attempts: { increment: 1 } })
    expect(waitMs()).toBeGreaterThanOrEqual(599_000)
    expect(mock.submit).not.toHaveBeenCalled()
    expect(writes().some(write => 'requestId' in write)).toBe(false)
  })
  it('still quarantines an unknown submission and leaves needs_review alone', async () => {
    claimed({ status: 'submitting' })
    await runAvatarWorkerOnce(logger)
    expect(writes()).toContainEqual({ status: 'needs_review', errorCode: 'submission_unknown' })
    expect(mock.submit).not.toHaveBeenCalled()
    expect(waitMs()).toBeGreaterThanOrEqual(AVATAR_STEP_INTERVAL_MS - 1_000)
  })
})

/**
 * Identity protocol matrix (#149). Tasks are addressed by stable identity
 * (library entry id) with device ids as aliases; every key resolves through
 * the alias table first. ENTRY / DEVICE / SKILL are the three id domains.
 */
describe('avatar identity: alias-first resolution, verifiable continuation, parking', () => {
  const ENTRY = 'entry-stable-id', DEVICE = 'device-avatar-id', SKILL = 'cloud-skill-id'
  const input = { name: 'Research', description: 'Find and organize sources', scenarios: [] }
  /** Keyed lookups by (owner, localSkillId); alias rows by (owner, alias). */
  const tasksByKey = (map: Record<string, Partial<SkillAvatar>>): void => {
    mock.skillAvatar.findUnique.mockImplementation(async (args: { where: { ownerId_localSkillId?: { ownerId: string; localSkillId: string }; skillId?: string; id?: string } }): Promise<SkillAvatar | null> => {
      const key = args.where.ownerId_localSkillId
      if (key) return key.ownerId === 'owner' && map[key.localSkillId] ? task({ id: `task:${key.localSkillId}`, localSkillId: key.localSkillId, ...map[key.localSkillId] }) : null
      if (args.where.skillId) {
        const entry = Object.entries(map).find(([, fields]) => fields.skillId === args.where.skillId)
        return entry ? task({ id: `task:${entry[0]}`, localSkillId: entry[0], ...entry[1] }) : null
      }
      return null
    })
  }
  const aliases = (map: Record<string, string>): void => {
    mock.skillAvatarAlias.findUnique.mockImplementation(async (args: { where: { ownerId_aliasLocalId: { ownerId: string; aliasLocalId: string } } }): Promise<unknown> => {
      const { ownerId, aliasLocalId } = args.where.ownerId_aliasLocalId
      const key = map[aliasLocalId]
      return ownerId === 'owner' && key ? { ownerId, aliasLocalId, avatarId: `task:${key}`, avatar: task({ id: `task:${key}`, localSkillId: key, skillId: SKILL }) } : null
    })
  }
  const ownedSkill = (): void => { mock.skill.findFirst.mockResolvedValue({ id: SKILL, displayName: 'Research', description: 'd', triggerScenarios: [] }) }
  const created = (): Array<Record<string, unknown>> => mock.skillAvatar.create.mock.calls.map(call => call[0].data as Record<string, unknown>)
  const aliasRows = (): Array<Record<string, unknown>> => mock.skillAvatarAlias.create.mock.calls.map(call => call[0].data as Record<string, unknown>)

  it.each([SKILL, null, 'different'])('first cloud binding requires the entry author asset (%s)', async authorSkillId => {
    tasksByKey({ [ENTRY]: { skillId: null, status: 'ready' } })
    ownedSkill()
    mock.libraryEntry.findFirst.mockResolvedValue({ userId: 'owner', deletedAt: null, authorSkillId })
    const request = ensureSkillAvatar({ ownerId: 'owner', localSkillId: ENTRY, skillId: SKILL })
    if (authorSkillId === SKILL) {
      await request
      expect(mock.skillAvatar.update).toHaveBeenCalledWith(expect.objectContaining({ data: { skill: { connect: { id: SKILL } } } }))
    } else {
      await expect(request).rejects.toMatchObject({ code: AVATAR_IDENTITY_CONFLICT })
      expect(mock.skillAvatar.update).not.toHaveBeenCalled()
    }
    expect(mock.skillAvatarGenerationAttempt.create).not.toHaveBeenCalled()
  })

  it('an old alias cannot bypass the canonical entry author binding', async () => {
    tasksByKey({ [ENTRY]: { skillId: null } })
    ownedSkill()
    mock.skillAvatarAlias.findUnique.mockResolvedValue({ avatarId: `task:${ENTRY}`, avatar: task({ id: `task:${ENTRY}`, localSkillId: ENTRY, skillId: null }) })
    mock.libraryEntry.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => where.id === ENTRY
      ? { userId: 'owner', deletedAt: null, authorSkillId: 'different' } : null)
    await expect(ensureSkillAvatar({ ownerId: 'owner', localSkillId: DEVICE, skillId: SKILL })).rejects.toMatchObject({ code: AVATAR_IDENTITY_CONFLICT })
    expect(mock.skillAvatar.update).not.toHaveBeenCalled()
  })

  it.each([null, 'different'])('a new task cannot bind an entry to the wrong author asset (%s)', async authorSkillId => {
    tasksByKey({})
    ownedSkill()
    mock.libraryEntry.findFirst.mockResolvedValue({ userId: 'owner', deletedAt: null, authorSkillId })
    await expect(ensureSkillAvatar({ ownerId: 'owner', localSkillId: ENTRY, skillId: SKILL })).rejects.toMatchObject({ code: AVATAR_IDENTITY_CONFLICT })
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
    expect(mock.skillAvatarGenerationAttempt.create).not.toHaveBeenCalled()
  })

  it('new client, no prior task: one task keyed by the entry id, device id registered as alias', async () => {
    tasksByKey({})
    const result = await ensureSkillAvatar({ ownerId: 'owner', localSkillId: ENTRY, aliasLocalIds: [DEVICE], input })
    expect(created()).toHaveLength(1)
    expect(created()[0]).toMatchObject({ localSkillId: ENTRY, ownerId: 'owner' })
    expect(aliasRows()).toEqual([{ ownerId: 'owner', aliasLocalId: DEVICE, avatarId: result.id }])
  })
  it('author-asset-first and multi-device: later devices hit the same entry-keyed task, nothing new is created', async () => {
    tasksByKey({ [ENTRY]: { skillId: SKILL, status: 'ready', url: 'https://picem-media.whatonearth.work/a.jpg' } })
    ownedSkill()
    const first = await ensureSkillAvatar({ ownerId: 'owner', localSkillId: ENTRY, aliasLocalIds: ['device-A'], skillId: SKILL })
    const second = await ensureSkillAvatar({ ownerId: 'owner', localSkillId: ENTRY, aliasLocalIds: ['device-B'], skillId: SKILL })
    expect(first.id).toBe(second.id)
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
    expect(aliasRows().map(row => row.aliasLocalId)).toEqual(['device-A', 'device-B'])
  })
  it('local-first continuation: an old device-keyed task is re-keyed to the entry only when entry → authorSkill is verifiable', async () => {
    tasksByKey({ [DEVICE]: { skillId: SKILL } })
    ownedSkill()
    mock.libraryEntry.findFirst.mockResolvedValue({ userId: 'owner', deletedAt: null, authorSkillId: SKILL })
    const result = await ensureSkillAvatar({ ownerId: 'owner', localSkillId: ENTRY, aliasLocalIds: [DEVICE], skillId: SKILL })
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
    expect(mock.skillAvatar.update.mock.calls[0][0]).toMatchObject({ where: { id: `task:${DEVICE}` }, data: { localSkillId: ENTRY } })
    expect(aliasRows()).toEqual([{ ownerId: 'owner', aliasLocalId: DEVICE, avatarId: `task:${DEVICE}` }])
    expect(result.localSkillId).toBe(ENTRY)
    expect(mock.libraryEntry.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ENTRY, userId: 'owner', deletedAt: null } }))
  })
  it('an old task with no cloud binding is never re-keyed on the client\'s alias claim alone: 409, no new task', async () => {
    tasksByKey({ [DEVICE]: { skillId: null } })
    mock.libraryEntry.findFirst.mockResolvedValue({ userId: 'owner', deletedAt: null, authorSkillId: SKILL })
    await expect(ensureSkillAvatar({ ownerId: 'owner', localSkillId: ENTRY, aliasLocalIds: [DEVICE] })).rejects.toMatchObject({ statusCode: 409, code: AVATAR_IDENTITY_CONFLICT })
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
    expect(mock.skillAvatar.update).not.toHaveBeenCalled()
    // Even with a requested skillId, the entry must name that very Skill.
    ownedSkill()
    mock.libraryEntry.findFirst.mockResolvedValue({ userId: 'owner', deletedAt: null, authorSkillId: 'another-skill' })
    await expect(ensureSkillAvatar({ ownerId: 'owner', localSkillId: ENTRY, aliasLocalIds: [DEVICE], skillId: SKILL })).rejects.toMatchObject({ code: AVATAR_IDENTITY_CONFLICT })
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
  })
  it('an unbound old task + the caller\'s other valid entry/asset + a claimed alias is refused: task, aliases and asset unchanged', async () => {
    // Old device-keyed task never bound to a cloud Skill; the request claims it
    // as alias and names a *different* asset that the entry really authors.
    tasksByKey({ [DEVICE]: { skillId: null, status: 'failed' } })
    ownedSkill()
    mock.libraryEntry.findFirst.mockResolvedValue({ userId: 'owner', deletedAt: null, authorSkillId: SKILL })
    await expect(ensureSkillAvatar({ ownerId: 'owner', localSkillId: ENTRY, aliasLocalIds: [DEVICE], skillId: SKILL })).rejects.toMatchObject({ statusCode: 409, code: AVATAR_IDENTITY_CONFLICT })
    expect(mock.skillAvatar.update).not.toHaveBeenCalled()
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
    expect(mock.skillAvatarAlias.create).not.toHaveBeenCalled()
    expect(mock.skill.update).not.toHaveBeenCalled()
    expect(mock.libraryEntry.findFirst).toHaveBeenCalled()
  })
  it('a cloud task with no local key is legally continued to the entry that authors it', async () => {
    mock.skillAvatar.findUnique.mockImplementation(async (args: { where: { ownerId_localSkillId?: unknown; skillId?: string } }): Promise<SkillAvatar | null> =>
      args.where.skillId === SKILL ? task({ id: 'cloud-task', localSkillId: null, skillId: SKILL, status: 'ready' }) : null)
    ownedSkill()
    mock.libraryEntry.findFirst.mockResolvedValue({ userId: 'owner', deletedAt: null, authorSkillId: SKILL })
    const result = await ensureSkillAvatar({ ownerId: 'owner', localSkillId: ENTRY, aliasLocalIds: [DEVICE], skillId: SKILL })
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
    expect(mock.skillAvatar.update.mock.calls[0][0]).toMatchObject({ where: { id: 'cloud-task' }, data: { localSkillId: ENTRY } })
    expect(aliasRows()).toEqual([{ ownerId: 'owner', aliasLocalId: DEVICE, avatarId: 'cloud-task' }])
    expect(result.localSkillId).toBe(ENTRY)
  })
  it('a key that is not among the request aliases cannot be continued; two distinct tasks are a parked 409', async () => {
    // Task keyed by some other device id, requested without listing it as alias.
    tasksByKey({ 'other-device': { skillId: SKILL } })
    ownedSkill()
    mock.libraryEntry.findFirst.mockResolvedValue({ userId: 'owner', deletedAt: null, authorSkillId: SKILL })
    await expect(ensureSkillAvatar({ ownerId: 'owner', localSkillId: ENTRY, skillId: SKILL })).rejects.toMatchObject({ code: AVATAR_IDENTITY_CONFLICT })
    // The incident shape: device-keyed task and entry-keyed task both exist.
    tasksByKey({ [DEVICE]: { skillId: null, status: 'failed' }, [ENTRY]: { skillId: SKILL, status: 'failed' } })
    await expect(ensureSkillAvatar({ ownerId: 'owner', localSkillId: ENTRY, aliasLocalIds: [DEVICE], skillId: SKILL })).rejects.toMatchObject({ statusCode: 409, code: AVATAR_IDENTITY_CONFLICT })
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
    expect(mock.skillAvatar.update).not.toHaveBeenCalled()
  })
  it('old client: its device id resolves through the alias table to the canonical task without renaming it', async () => {
    tasksByKey({ [ENTRY]: { skillId: SKILL, status: 'ready' } })
    aliases({ [DEVICE]: ENTRY })
    const result = await ensureSkillAvatar({ ownerId: 'owner', localSkillId: DEVICE, input })
    expect(result.localSkillId).toBe(ENTRY)
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
    expect(mock.skillAvatar.update).not.toHaveBeenCalled()
    // …and an old client claiming a different cloud Skill is refused.
    ownedSkill()
    await expect(ensureSkillAvatar({ ownerId: 'owner', localSkillId: DEVICE, skillId: 'yet-another', input })).rejects.toMatchObject({ statusCode: 409 })
  })
  it('cross-account isolation: another owner never resolves this account\'s keys, and a foreign cloud task is a conflict', async () => {
    tasksByKey({ [ENTRY]: { skillId: SKILL } })
    aliases({ [DEVICE]: ENTRY })
    await ensureSkillAvatar({ ownerId: 'other', localSkillId: ENTRY, input })
    expect(created()).toHaveLength(1)
    expect(created()[0]).toMatchObject({ ownerId: 'other', localSkillId: ENTRY })
    mock.skillAvatar.findUnique.mockImplementation(async (args: { where: { skillId?: string } }): Promise<SkillAvatar | null> => args.where.skillId ? task({ ownerId: 'someone-else', skillId: SKILL }) : null)
    mock.skill.findFirst.mockResolvedValue({ id: SKILL, displayName: 'x', description: 'd', triggerScenarios: [] })
    await expect(ensureSkillAvatar({ ownerId: 'owner', skillId: SKILL })).rejects.toMatchObject({ statusCode: 409, code: AVATAR_IDENTITY_CONFLICT })
  })
  it('author-asset publishing only binds an entry-keyed task; it never creates one or steals a bound task', async () => {
    tasksByKey({})
    expect(await bindCloudAvatarToEntry('owner', SKILL, ENTRY)).toBe(false)
    expect(mock.skillAvatar.create).not.toHaveBeenCalled()
    tasksByKey({ [ENTRY]: { skillId: null } })
    expect(await bindCloudAvatarToEntry('owner', SKILL, ENTRY)).toBe(true)
    expect(mock.skillAvatar.update.mock.calls.at(-1)?.[0]).toMatchObject({ where: { id: `task:${ENTRY}` }, data: { skill: { connect: { id: SKILL } } } })
    tasksByKey({ [ENTRY]: { skillId: 'another-skill' } })
    expect(await bindCloudAvatarToEntry('owner', SKILL, ENTRY)).toBe(false)
  })
  it('retired tasks are never candidates', async () => {
    tasksByKey({ [DEVICE]: { skillId: SKILL, status: 'superseded' }, [ENTRY]: { skillId: SKILL, status: 'failed' } })
    ownedSkill()
    const result = await ensureSkillAvatar({ ownerId: 'owner', localSkillId: ENTRY, aliasLocalIds: [DEVICE], skillId: SKILL })
    expect(result.id).toBe(`task:${ENTRY}`)
  })
})
