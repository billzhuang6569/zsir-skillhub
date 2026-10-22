import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AvatarTask } from './avatar-jobs.js'
import { classicAvatarStyle } from './avatar-style-catalog.js'
const mock = vi.hoisted(() => ({ draft: vi.fn(), ai: vi.fn(), submit: vi.fn(), persist: vi.fn(), style: vi.fn(),
  online: vi.fn(), enabled: vi.fn(), claim: vi.fn() }))
vi.mock('../config.js', () => ({ config: { SKILLHUB_PROFILE: 'selfhost', SKILL_AVATAR_MODEL_READS: 'variants' } }))
vi.mock('../db.js', () => ({ db: {} }))
vi.mock('../routes/skills.js', () => ({ requestConfiguredAiDraft: mock.draft }))
vi.mock('./ai-settings.js', () => ({ resolveAiConfig: mock.ai }))
vi.mock('./avatar-generation.js', () => ({ avatarGenerationEnabled: mock.enabled }))
vi.mock('./fal.js', async original => ({ ...await original<typeof import('./fal.js')>(), submitFalAvatar: mock.submit }))
vi.mock('./avatar-jobs.js', () => ({ persistAvatarJob: mock.persist, claimAvatarJob: mock.claim }))
vi.mock('./avatar-styles.js', () => ({ getAvatarStyle: mock.style }))
vi.mock('./local-ai-tasks.js', async original => ({ ...await original<typeof import('./local-ai-tasks.js')>(), avatarDraftClientOnline: mock.online }))
import { claimAvatar, processAvatar, runClaimedAvatar } from './skill-avatars.js'
import { avatarDraftWithCanvas } from './local-ai-tasks.js'
import type { FastifyBaseLogger } from 'fastify'

function task(status = 'queued', changes: Partial<NonNullable<AvatarTask['job']>> = {}): AvatarTask {
  const now = new Date()
  const job = { id: 'job', ownerId: 'owner', logicalSkillId: 'anchor', styleId: 'classic', styleVersion: 1,
    input: { name: 'Research', description: 'Summarize research', scenarios: [] }, status, prompt: null, promptSource: null,
    draftDeadline: null, submittedAt: null, requestId: null, leaseToken: 'worker', attempts: 0,
    falModel: classicAvatarStyle.fal.meta.model, falParameters: classicAvatarStyle.fal.meta.parameters,
    generationRevision: 1, selectionRevision: 1, inputFingerprint: 'input', promptVersion: 'v1', promptSha256: null,
    idempotencyKey: 'avatar:anchor:1', imageUrl: null, imageData: null, imageSha256: null, assetId: null, url: null,
    errorCode: null, nextAttemptAt: now, leaseUntil: null, queuedAt: now, createdAt: now, updatedAt: now, path: null, ...changes }
  return { ...job, job, skillId: null, localSkillId: null, currentJobId: job.id, source: 'generated',
    customAssetId: null, customUrl: null, customUpdatedAt: null }
}
const draft = (classicAvatarStyle.legacy.fixedStyle + '\n' + 'A balanced geometric composition. '.repeat(12)).trim()
const submitted = (): Record<string, unknown> => mock.persist.mock.calls.find(call => call[1].status === 'submitting')?.[1]
beforeEach(() => {
  vi.resetAllMocks(); mock.persist.mockResolvedValue(true); mock.style.mockResolvedValue(classicAvatarStyle)
  mock.enabled.mockReturnValue(true); mock.ai.mockResolvedValue(null); mock.online.mockReturnValue(false)
  mock.draft.mockResolvedValue(draft); mock.submit.mockResolvedValue('request')
})
describe('variants prompt paths', () => {
  it('uses configured instance AI and preserves its validated canvas prompt', async (): Promise<void> => {
    mock.ai.mockResolvedValue({}); await processAvatar(task())
    expect(submitted()).toMatchObject({ path: 'meta', promptSource: 'instance', prompt: avatarDraftWithCanvas(draft, classicAvatarStyle) })
    expect(mock.submit).toHaveBeenCalledTimes(1)
  })
  it.each(['error', 'invalid'])('falls back directly before submitting on AI %s', async (reason): Promise<void> => {
    mock.ai.mockResolvedValue({})
    if (reason === 'error') mock.draft.mockRejectedValue(new Error('offline'))
    else mock.draft.mockResolvedValue('invalid')
    await processAvatar(task()); expect(submitted()).toMatchObject({ path: 'direct', promptSource: 'direct' })
    expect(mock.submit).toHaveBeenCalledTimes(1)
  })
  it('without AI or a live client uses direct without an AI request', async (): Promise<void> => {
    await processAvatar(task()); expect(submitted()).toMatchObject({ path: 'direct', promptSource: 'direct' })
    expect(mock.draft).not.toHaveBeenCalled()
  })
  it('degrades to direct if resolving AI settings fails, even with a live local client', async (): Promise<void> => {
    mock.ai.mockRejectedValue(new Error('configuration unavailable')); mock.online.mockReturnValue(true)
    await processAvatar(task()); expect(submitted()).toMatchObject({ path: 'direct', promptSource: 'direct' })
    expect(mock.draft).not.toHaveBeenCalled(); expect(mock.submit).toHaveBeenCalledTimes(1)
  })
  it('waits ten minutes for an online local client and releases the worker lease', async (): Promise<void> => {
    mock.online.mockReturnValue(true); const start = Date.now(); await processAvatar(task())
    const data = mock.persist.mock.calls[0][1]
    expect(data).toMatchObject({ status: 'drafting', leaseToken: null, leaseUntil: null })
    expect(data.nextAttemptAt).toEqual(data.draftDeadline)
    expect(data.draftDeadline.getTime()).toBeGreaterThanOrEqual(start + 600_000)
    expect(mock.submit).not.toHaveBeenCalled()
  })
  it('never re-enters drafting once a deadline was recorded, and skips oversized briefs', async (): Promise<void> => {
    mock.online.mockReturnValue(true)
    await processAvatar(task('queued', { draftDeadline: new Date() }))
    expect(submitted()).toMatchObject({ path: 'direct' })
    mock.persist.mockClear(); mock.style.mockResolvedValue({ ...classicAvatarStyle, metaPrompt: 'x'.repeat(16 * 1024 + 1) })
    await processAvatar(task()); expect(submitted()).toMatchObject({ path: 'direct' })
  })
  it('submits the saved local prompt without calling AI or appending the canvas again', async (): Promise<void> => {
    const prompt = avatarDraftWithCanvas(draft, classicAvatarStyle)
    await processAvatar(task('queued', { prompt, promptSource: 'local' }))
    expect(submitted()).toMatchObject({ prompt, path: 'meta', promptSource: 'local' })
    expect(mock.ai).not.toHaveBeenCalled(); expect(mock.draft).not.toHaveBeenCalled()
    expect(mock.submit).toHaveBeenCalledWith(prompt, classicAvatarStyle.fal.meta)
  })
  it('drafting expires to direct even if AI or a client is now online', async (): Promise<void> => {
    mock.ai.mockResolvedValue({}); mock.online.mockReturnValue(true)
    await processAvatar(task('drafting')); expect(submitted()).toMatchObject({ path: 'direct', promptSource: 'direct' })
    expect(mock.ai).not.toHaveBeenCalled(); expect(mock.submit).toHaveBeenCalledTimes(1)
  })
  it('does not submit when the atomic draft transition is deferred or lost', async (): Promise<void> => {
    mock.persist.mockResolvedValue(false); await processAvatar(task('drafting'))
    expect(mock.submit).not.toHaveBeenCalled()
  })
  it('quarantines unknown submissions without fallback or a second paid request', async (): Promise<void> => {
    mock.ai.mockResolvedValue({}); mock.submit.mockRejectedValue(new Error('timeout'))
    await processAvatar(task())
    expect(mock.submit).toHaveBeenCalledTimes(1)
    expect(mock.persist).toHaveBeenLastCalledWith(expect.anything(), { status: 'needs_review', errorCode: 'submission_unknown' })
    await processAvatar(task('submitting')); expect(mock.submit).toHaveBeenCalledTimes(1)
  })
  it('does not claim generate work or call providers when fal is disabled', async (): Promise<void> => {
    mock.enabled.mockReturnValue(false)
    expect(await claimAvatar(['queued', 'drafting'])).toBeNull(); expect(mock.claim).not.toHaveBeenCalled()
    await processAvatar(task()); expect(mock.submit).not.toHaveBeenCalled(); expect(mock.persist).not.toHaveBeenCalled()
    mock.claim.mockResolvedValue(null)
    await claimAvatar(['queued', 'awaiting', 'transferring'])
    expect(mock.claim).toHaveBeenCalledWith(['transferring'], expect.any(Date))
  })
  it('final release is fenced by the original worker token after scheduling drafting', async (): Promise<void> => {
    mock.online.mockReturnValue(true)
    const avatar = task(); await runClaimedAvatar(avatar, { warn: vi.fn() } as unknown as FastifyBaseLogger)
    expect(mock.persist.mock.calls[0][1]).toMatchObject({ status: 'drafting', leaseToken: null })
    expect(mock.persist.mock.lastCall?.[0].leaseToken).toBe('worker')
  })
})
