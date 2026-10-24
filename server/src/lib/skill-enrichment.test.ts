import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillEnrichment } from '@prisma/client'

const mock = vi.hoisted(() => ({
  config: { SKILLHUB_PROFILE: 'selfhost', AI_MAX_CONCURRENT: 2, AI_TIMEOUT_MS: 1000, SKILL_AVATARS_ENABLED: true, SKILL_AVATAR_MODEL_READS: 'legacy' },
  ai: true, fal: true, analyze: vi.fn(), avatar: vi.fn(),
  skill: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  skillEnrichment: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), createMany: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock('../db.js', () => ({ db: mock }))
vi.mock('../config.js', () => ({ config: mock.config }))
vi.mock('./ai-settings.js', () => ({ aiStatus: () => ({ configured: mock.ai }) }))
vi.mock('./fal-settings.js', () => ({ falAvailable: () => mock.fal }))
vi.mock('./avatar-generation.js', () => ({ avatarGenerationEnabled: () => mock.config.SKILLHUB_PROFILE === 'selfhost' ? mock.fal : mock.config.SKILL_AVATARS_ENABLED }))
vi.mock('../routes/skills.js', () => ({ analyzeSkillWithAI: mock.analyze }))
vi.mock('./mutation-lock.js', () => ({ lockUserMutation: vi.fn(), lockSkillMutation: vi.fn() }))
vi.mock('./skill-avatars.js', async original => ({ ...await original<typeof import('./skill-avatars.js')>(), ensureEnrichmentAvatar: mock.avatar }))

import { enrichmentCycle, runSkillEnrichment, scanSkillEnrichment, startSkillEnrichmentWorker } from './skill-enrichment.js'
import { AiRequestGuardError } from '../utils/ai-request-guard.js'
import { AvatarError } from './skill-avatars.js'
import type { FastifyBaseLogger } from 'fastify'

const job = (changes: Partial<SkillEnrichment> = {}): SkillEnrichment => ({ skillId: 'skill', phase: 'analysis', attempts: 0,
  awaitingAnalysis: false, errorCode: null, nextAttemptAt: new Date(0), leaseToken: 'lease', leaseUntil: new Date(Date.now() + 60_000), ...changes })
const skill = { id: 'skill', authorId: 'owner', name: 'author-latest', sourceContent: '# Latest author content',
  analysisStatus: 'unanalysed', deletedAt: null, avatarUrl: null, avatar: null, updatedAt: new Date(0),
  displayName: 'Original', description: 'Description', category: 'Tools', triggerScenarios: ['scenario'],
  profileManuallyEdited: false, labelsManuallyEdited: true, labels: ['manual'] }

describe.each(['selfhost', 'yitan-official'])('persistent enrichment (%s)', profile => {
  beforeEach(() => {
    vi.resetAllMocks()
    mock.config.SKILLHUB_PROFILE = profile
    mock.config.AI_MAX_CONCURRENT = 2
    mock.config.SKILL_AVATAR_MODEL_READS = 'legacy'
    mock.ai = true; mock.fal = true; mock.config.SKILL_AVATARS_ENABLED = true
    mock.$transaction.mockImplementation(async (fn: (tx: typeof mock) => Promise<unknown>) => fn(mock))
    mock.skill.findMany.mockResolvedValue([{ id: 'skill' }])
    mock.skill.findUnique.mockResolvedValue({ ...skill })
    mock.skill.updateMany.mockResolvedValue({ count: 1 })
    mock.skillEnrichment.findMany.mockResolvedValue([job()])
    mock.skillEnrichment.updateMany.mockResolvedValue({ count: 1 })
    mock.analyze.mockResolvedValue({ source: 'ai', profile: { displayName: 'Analyzed', description: 'New', labels: ['generated'], triggerScenarios: [] } })
  })
  it('compensates all creation paths with a bounded idempotent scan and excludes inherited copies', async () => {
    await scanSkillEnrichment()
    expect(mock.skill.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10,
      where: { deletedAt: null, analysisStatus: 'unanalysed', avatarUrl: null, enrichment: null } }))
    expect(mock.skillEnrichment.createMany).toHaveBeenCalledWith({ data: [{ skillId: 'skill', phase: 'analysis' }], skipDuplicates: true })
  })
  it('uses low priority and latest author content, protects manual labels, then schedules the avatar', async () => {
    await enrichmentCycle()
    expect(mock.analyze).toHaveBeenCalledWith('author-latest', skill.sourceContent, 'owner', undefined, 'background')
    expect(mock.skill.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ authorId: 'owner', sourceContent: skill.sourceContent, displayName: skill.displayName,
        labels: { equals: skill.labels }, profileManuallyEdited: false, analysisStatus: 'unanalysed' }),
      data: expect.objectContaining({ labels: ['manual'], analysisStatus: 'completed' }),
    }))
    expect(mock.skillEnrichment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ phase: 'avatar' }) }))
    expect(mock.avatar).not.toHaveBeenCalled()
    await runSkillEnrichment(job({ phase: 'avatar' }))
    expect(mock.avatar).toHaveBeenCalledWith('owner', 'skill')
  })
  it.each([{ analysisStatus: 'completed' }, { avatarUrl: 'https://images.example.test/inherited.jpg' },
    { avatar: { source: 'custom', customUrl: 'https://images.example.test/custom.jpg' } }])('leaves inherited analysis/images untouched: %j', async changes => {
    mock.skill.findUnique.mockResolvedValue({ ...skill, ...changes })
    await runSkillEnrichment(job())
    expect(mock.analyze).not.toHaveBeenCalled(); expect(mock.avatar).not.toHaveBeenCalled()
  })
  it('does not send manually edited profiles to AI', async () => {
    mock.skill.findUnique.mockResolvedValue({ ...skill, profileManuallyEdited: true })
    await runSkillEnrichment(job())
    expect(mock.analyze).not.toHaveBeenCalled(); expect(mock.skill.updateMany).not.toHaveBeenCalled()
  })
  it('waits for a metadata-only create to receive source instead of permanently skipping analysis', async () => {
    mock.skill.findUnique.mockResolvedValue({ ...skill, sourceContent: null })
    await runSkillEnrichment(job())
    expect(mock.analyze).not.toHaveBeenCalled()
    expect(mock.skillEnrichment.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.not.objectContaining({ phase: 'avatar' }) }))
    mock.skill.findUnique.mockResolvedValue({ ...skill })
    await runSkillEnrichment(job())
    expect(mock.analyze).toHaveBeenCalledOnce()
  })
  it('also protects a ready variants selection when frozen Skill avatar columns are empty', async () => {
    mock.config.SKILL_AVATAR_MODEL_READS = 'variants'
    mock.skill.findUnique.mockResolvedValue({ ...skill, avatar: { source: 'generated', status: 'pending', url: null,
      selection: { source: 'generated', variant: { url: '/media/inherited.jpg' } } } })
    await runSkillEnrichment(job())
    expect(mock.analyze).not.toHaveBeenCalled(); expect(mock.avatar).not.toHaveBeenCalled()
  })
  it('discards analysis when a custom avatar is uploaded during the AI call', async () => {
    mock.skill.findUnique.mockResolvedValueOnce({ ...skill }).mockResolvedValueOnce({ ...skill,
      avatar: { source: 'custom', customUrl: '/media/custom.jpg' } })
    await runSkillEnrichment(job())
    expect(mock.skill.updateMany).not.toHaveBeenCalled()
    expect(mock.skillEnrichment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ phase: 'done' }) }))
  })
  it('discards concurrent edits and stale leases instead of committing a stale profile', async () => {
    mock.skill.updateMany.mockResolvedValue({ count: 0 })
    await runSkillEnrichment(job())
    expect(mock.skillEnrichment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ phase: 'analysis' }) }))
    mock.skill.updateMany.mockClear(); mock.skillEnrichment.updateMany.mockResolvedValue({ count: 0 })
    await runSkillEnrichment(job())
    expect(mock.skill.updateMany).not.toHaveBeenCalled()
  })
  it('does nothing when neither provider is configured, and resumes scanning after configuration', async () => {
    mock.ai = false; mock.fal = false; mock.config.SKILL_AVATARS_ENABLED = false
    await enrichmentCycle()
    expect(mock.skill.findMany).not.toHaveBeenCalled(); expect(mock.skillEnrichment.findMany).not.toHaveBeenCalled()
    mock.ai = true
    await enrichmentCycle()
    expect(mock.analyze).toHaveBeenCalledOnce()
    expect(mock.skillEnrichment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ phase: { in: ['analysis'] } }) }))
  })
  it('only admits avatar work with fal and only analysis work with AI', async () => {
    mock.ai = false; mock.skillEnrichment.findMany.mockResolvedValue([])
    await enrichmentCycle()
    expect(mock.skillEnrichment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ phase: { in: ['analysis', 'avatar'] } }) }))
    expect(mock.skillEnrichment.createMany).toHaveBeenCalledWith({ data: [{ skillId: 'skill', phase: 'analysis' }], skipDuplicates: true })
  })
  it('leaves the only AI slot for users', async () => {
    mock.config.AI_MAX_CONCURRENT = 1; mock.skillEnrichment.findMany.mockResolvedValue([])
    await enrichmentCycle()
    expect(mock.analyze).not.toHaveBeenCalled()
    expect(mock.skillEnrichment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ phase: { in: ['analysis', 'avatar'] } }) }))
    await runSkillEnrichment(job())
    expect(mock.skillEnrichment.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ phase: 'avatar', awaitingAnalysis: true }) }))
  })
  it('does not run a lost claim', async () => {
    mock.skillEnrichment.updateMany.mockResolvedValue({ count: 0 })
    await enrichmentCycle(); expect(mock.analyze).not.toHaveBeenCalled()
    expect(mock.skillEnrichment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ phase: 'analysis' }) }))
  })
  it('retains profile on failure, backs off, and stops after five failures', async () => {
    mock.analyze.mockResolvedValue({ source: 'fallback' })
    await runSkillEnrichment(job())
    expect(mock.skill.updateMany).not.toHaveBeenCalled()
    expect(mock.skillEnrichment.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ attempts: 1, phase: 'analysis', leaseToken: null }) }))
    await runSkillEnrichment(job({ attempts: 4 }))
    expect(mock.skillEnrichment.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ attempts: 5, phase: 'failed' }) }))
  })
  it.each(['concurrency', 'daily', 'per_minute', 'user_daily'] as const)('defers guard %s without consuming retries', async reason => {
    mock.analyze.mockRejectedValue(new AiRequestGuardError('wait', 3600, reason))
    const before = Date.now()
    await runSkillEnrichment(job({ attempts: 2 }))
    const data = mock.skillEnrichment.updateMany.mock.lastCall![0].data
    expect(data.attempts).toBe(2); expect(data.phase).toBe('analysis')
    expect(data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 3600_000)
  })
  it('defers the daily avatar quota without retrying paid work', async () => {
    mock.avatar.mockRejectedValue(new AvatarError(429, 'quota', 'AVATAR_DAILY_QUOTA', 3600))
    await runSkillEnrichment(job({ phase: 'avatar' }))
    expect(mock.skillEnrichment.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ phase: 'avatar', attempts: 0 }) }))
  })
  it('parks a conflicting device identity for explicit recovery instead of retrying forever', async () => {
    mock.avatar.mockRejectedValueOnce(new AvatarError(409, 'identity', 'AVATAR_IDENTITY_CONFLICT', 3600))
    await runSkillEnrichment(job({ phase: 'avatar' }))
    expect(mock.skillEnrichment.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ phase: 'parked', attempts: 0, errorCode: 'AVATAR_IDENTITY_CONFLICT' }) }))
  })
  it('ignores install and avatar mirror timestamps when committing analysis', async () => {
    mock.skill.findUnique.mockResolvedValueOnce({ ...skill }).mockResolvedValueOnce({ ...skill, updatedAt: new Date(), installCount: 100 })
    await runSkillEnrichment(job())
    const where = mock.skill.updateMany.mock.lastCall![0].where
    expect(where).not.toHaveProperty('updatedAt')
    expect(where).not.toHaveProperty('installCount')
    expect(mock.skillEnrichment.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ phase: 'avatar' }) }))
  })
  it('persists attempts before paid calls and bounds crash reclaims and failed profile CAS', async () => {
    mock.skill.updateMany.mockResolvedValue({ count: 0 })
    mock.analyze.mockImplementation(async () => {
      expect(mock.skillEnrichment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { attempts: { increment: 1 } } }))
      return { source: 'ai', profile: {} }
    })
    await runSkillEnrichment(job({ attempts: 4 }))
    expect(mock.skillEnrichment.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ phase: 'failed', attempts: 5 }) }))
    await runSkillEnrichment(job({ attempts: 5 }))
    expect(mock.analyze).toHaveBeenCalledOnce()
  })
  it('analyzes a fal-first task after AI configuration without generating another image', async () => {
    mock.ai = false
    await runSkillEnrichment(job())
    expect(mock.skillEnrichment.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ phase: 'avatar', awaitingAnalysis: true }) }))
    await runSkillEnrichment(job({ phase: 'avatar', awaitingAnalysis: true }))
    expect(mock.avatar).toHaveBeenCalledOnce()
    mock.ai = true
    mock.skillEnrichment.findMany.mockResolvedValue([job({ phase: 'done', awaitingAnalysis: true })])
    await scanSkillEnrichment()
    expect(mock.skillEnrichment.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ phase: 'done', awaitingAnalysis: true }), data: expect.objectContaining({ phase: 'analysis' }) }))
    mock.skill.findUnique.mockResolvedValue({ ...skill, avatarUrl: '/media/generated.jpg' })
    await runSkillEnrichment(job({ awaitingAnalysis: true }))
    expect(mock.analyze).toHaveBeenCalledOnce()
    await runSkillEnrichment(job({ phase: 'avatar' }))
    expect(mock.avatar).toHaveBeenCalledOnce()
  })
  it('waits an hour for missing source/config and logs only a safe code and identity on failure', async () => {
    const before = Date.now()
    mock.skill.findUnique.mockResolvedValue({ ...skill, sourceContent: null })
    await runSkillEnrichment(job())
    expect(mock.skillEnrichment.updateMany.mock.lastCall![0].data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 3600_000)
    mock.skill.findUnique.mockResolvedValue({ ...skill }); mock.ai = false; mock.fal = false; mock.config.SKILL_AVATARS_ENABLED = false
    await runSkillEnrichment(job())
    expect(mock.skillEnrichment.updateMany.mock.lastCall![0].data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 3600_000)
    mock.ai = true; mock.analyze.mockRejectedValue(new Error('private prompt text'))
    const warn = vi.fn()
    await runSkillEnrichment(job(), { warn } as unknown as FastifyBaseLogger)
    expect(warn).toHaveBeenCalledWith({ skillId: 'skill', errorCode: 'ENRICHMENT_FAILED' }, 'Skill enrichment deferred')
  })
  it.each([{ avatar: { source: 'custom', customUrl: '/media/custom.jpg' } }, { profileManuallyEdited: true }])('stops waiting for AI after a protected user change: %j', async changes => {
    mock.skill.findUnique.mockResolvedValue({ ...skill, ...changes })
    await runSkillEnrichment(job({ awaitingAnalysis: true }))
    expect(mock.analyze).not.toHaveBeenCalled()
    expect(mock.skillEnrichment.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ awaitingAnalysis: false }) }))
  })
  it('protects a custom variants selection when AI is configured after fal', async () => {
    mock.config.SKILL_AVATAR_MODEL_READS = 'variants'
    mock.skill.findUnique.mockResolvedValue({ ...skill, avatar: { source: 'generated', status: 'ready', url: null,
      selection: { source: 'custom', customUrl: '/media/custom.jpg', revision: 2 } } })
    await runSkillEnrichment(job({ awaitingAnalysis: true }))
    expect(mock.analyze).not.toHaveBeenCalled()
    expect(mock.skillEnrichment.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ awaitingAnalysis: false }) }))
  })
  it('drains in-flight work on shutdown and never overlaps cycles', async () => {
    vi.useFakeTimers()
    let release: () => void = () => undefined
    mock.skill.findMany.mockImplementation(() => new Promise(resolve => { release = () => resolve([]) }))
    try {
      const stop = startSkillEnrichmentWorker({ warn: vi.fn() } as unknown as FastifyBaseLogger)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mock.skill.findMany).toHaveBeenCalledOnce()
      release(); await stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mock.skill.findMany).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
})
