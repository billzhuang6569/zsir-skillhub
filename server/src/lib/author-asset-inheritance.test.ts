import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { inheritAuthorAsset } from './author-asset-inheritance.js'
const settings = vi.hoisted(() => ({ SKILLHUB_PROFILE: 'yitan-official', SKILL_AVATAR_MODEL_READS: 'legacy' }))
vi.mock('../config.js', () => ({ config: settings }))

describe.each(['selfhost', 'yitan-official'])('author asset inheritance (%s)', (profile) => {
  beforeEach(() => { settings.SKILLHUB_PROFILE = profile; settings.SKILL_AVATAR_MODEL_READS = 'legacy' })
  it('variants preserves analysis without creating a job-dependent avatar anchor', async () => {
    settings.SKILL_AVATAR_MODEL_READS = 'variants'
    const update = vi.fn()
    const create = vi.fn()
    const db = { skill: { findFirst: vi.fn().mockResolvedValue({ displayName: 'Source', labels: [], triggerScenarios: [], analysisStatus: 'completed', avatar: { source: 'custom', customUrl: 'https://images.example.test/custom.jpg', customAssetId: 'asset' } }), update }, skillAvatar: { create } } as unknown as Prisma.TransactionClient
    await inheritAuthorAsset(db, 'owner', 'new', 'source')
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ analysisStatus: 'completed' }) }))
    expect(create).not.toHaveBeenCalled()
  })
  it.each(['author', 'team', 'marketplace'])('checks %s access and reuses a ready image without generation writes', async (access) => {
    const source = { displayName: 'Source', description: 'Existing analysis', category: 'tools', labels: ['test'], triggerScenarios: ['test'], analysisStatus: 'completed',
      avatar: { source: access === 'author' ? 'custom' : 'generated', status: 'ready', url: 'https://images.example.test/ready.jpg', assetId: 'public-asset', customUrl: 'https://images.example.test/custom.jpg', customAssetId: 'custom-asset' } }
    const findFirst = vi.fn().mockResolvedValue(source)
    const update = vi.fn().mockResolvedValue({})
    const create = vi.fn().mockResolvedValue({})
    const db = { skill: { findFirst, update }, skillAvatar: { create } } as unknown as Prisma.TransactionClient
    await inheritAuthorAsset(db, 'member', 'new-skill', 'source-skill')
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'source-skill', deletedAt: null, OR: [{ authorId: 'member' }, { versions: { some: { card: { grants: { some: { userId: 'member' } } } } } }] } }))
    expect(update.mock.calls[0][0].data).not.toHaveProperty('displayName')
    expect(update.mock.calls[0][0].data).not.toHaveProperty('description')
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ analysisStatus: 'completed', labels: ['test'], avatarStatus: 'ready' }) }))
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ source: 'custom', status: 'cancelled', customAssetId: access === 'author' ? 'custom-asset' : 'public-asset' }) })
    const data = create.mock.calls[0][0].data
    for (const field of ['queuedAt', 'requestId', 'currentJobId', 'generationAttempts', 'jobs']) expect(data).not.toHaveProperty(field)
  })

  it('ignores an inaccessible or missing source without writes or errors', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const update = vi.fn()
    const create = vi.fn()
    await inheritAuthorAsset({ skill: { findFirst, update }, skillAvatar: { create } } as unknown as Prisma.TransactionClient, 'stranger', 'new', 'source')
    expect(update).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  })

  it.each(['unanalysed', 'pending', 'failed'])('does not inherit incomplete analysis (%s) or an unfinished image', async (analysisStatus) => {
    const update = vi.fn()
    const create = vi.fn()
    await inheritAuthorAsset({ skill: { findFirst: vi.fn().mockResolvedValue({ displayName: 'Source', labels: [], triggerScenarios: [], analysisStatus, avatar: { source: 'generated', status: 'pending' } }), update }, skillAvatar: { create } } as unknown as Prisma.TransactionClient, 'owner', 'new', 'source')
    expect(update).toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
    expect(update.mock.calls[0][0].data).not.toHaveProperty('analysisStatus')
    expect(update.mock.calls[0][0].data).not.toHaveProperty('labels')
  })
})
