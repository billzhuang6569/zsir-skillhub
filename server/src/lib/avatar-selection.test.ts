import type { Prisma } from '@prisma/client'
import { beforeEach, expect, it, vi } from 'vitest'
const settings = vi.hoisted(() => ({ SKILL_AVATAR_MODEL_READS: 'variants' }))
const database = vi.hoisted(() => ({ skillAvatar: { findMany: vi.fn(), findUnique: vi.fn() }, marketplaceListing: { updateMany: vi.fn() }, $queryRaw: vi.fn() }))
vi.mock('../config.js', () => ({ config: settings }))
vi.mock('../db.js', () => ({ db: database }))
import { fillEmptyListingAvatar, listingAvatar, projectSkillAvatars, selectionAvatar, type SelectionDisplay } from './avatar-selection.js'
const selected = (overrides: Partial<SelectionDisplay> = {}): SelectionDisplay => ({ source: 'generated', customUrl: null, revision: 2, variant: { url: 'selected' }, currentJob: { status: 'failed' }, ...overrides })
beforeEach(() => { vi.clearAllMocks(); settings.SKILL_AVATAR_MODEL_READS = 'variants' })

it('uses custom, then immutable variant, then desired Job state; never the mirror or frozen Skill', () => {
  expect(selectionAvatar(selected())).toEqual({ avatarUrl: 'selected', avatarStatus: 'ready', avatarSource: 'generated' })
  expect(selectionAvatar(selected({ source: 'custom', customUrl: 'uploaded' }))).toEqual({ avatarUrl: 'uploaded', avatarStatus: 'ready', avatarSource: 'custom' })
  expect(selectionAvatar(selected({ variant: null }))).toMatchObject({ avatarUrl: null, avatarStatus: 'failed' })
  expect(selectionAvatar(selected({ variant: null, currentJob: { status: 'needs_review' } }))).toMatchObject({ avatarStatus: 'needs_review' })
  expect(selectionAvatar(null)).toMatchObject({ avatarUrl: null, avatarStatus: 'none' })
})

it('batch projects by the authored Skill identity, preserving other DTO fields', async () => {
  database.skillAvatar.findMany.mockResolvedValue([{ skillId: 'shared', selection: selected() }])
  const input = [{ id: 'shared', authorId: 'owner', avatarUrl: 'frozen', name: 'Shared' }, { id: 'missing', authorId: 'viewer', avatarUrl: 'stale', name: 'Own' }]
  const result = await projectSkillAvatars(input)
  expect(result[0]).toMatchObject({ name: 'Shared', avatarUrl: 'selected', avatarSource: 'generated' })
  expect(result[1]).toMatchObject({ avatarUrl: null, avatarStatus: 'none' })
  expect(database.skillAvatar.findMany).toHaveBeenCalledTimes(1)
  expect(database.skillAvatar.findMany.mock.calls[0][0].where).toEqual({ skillId: { in: ['shared','missing'] } })
  settings.SKILL_AVATAR_MODEL_READS = 'legacy'
  expect(await projectSkillAvatars(input)).toBe(input)
  expect(database.skillAvatar.findMany).toHaveBeenCalledTimes(1)
})

it('store projection uses only the listing snapshot and retains the legacy shape in legacy mode', () => {
  const snapshot = { avatarUrl: 'approved', avatarStatus: 'ready', avatarSource: 'custom' }
  expect(listingAvatar(snapshot, { avatarUrl: 'live', avatarStatus: 'pending' })).toEqual(snapshot)
  settings.SKILL_AVATAR_MODEL_READS = 'legacy'
  expect(listingAvatar(snapshot, { avatarUrl: 'live', avatarStatus: 'pending' })).toEqual({ avatarUrl: 'live', avatarStatus: 'pending' })
})

it('fills only null snapshots from a ready selection under the Skill lock', async () => {
  const tx = database as unknown as Prisma.TransactionClient
  database.skillAvatar.findUnique.mockResolvedValue({ selection: selected({ source: 'custom', customUrl: 'uploaded' }) })
  await fillEmptyListingAvatar(tx, 'author', 'skill')
  expect(database.$queryRaw).toHaveBeenCalledTimes(1)
  expect(database.marketplaceListing.updateMany).toHaveBeenCalledWith({ where: { skillId: 'skill', avatarUrl: null }, data: {
    avatarUrl: 'uploaded', avatarStatus: 'ready', avatarSource: 'custom', avatarUpdatedById: 'author', avatarSnapshotAt: expect.any(Date),
  } })
  database.skillAvatar.findUnique.mockResolvedValue({ selection: selected({ variant: null }) })
  await fillEmptyListingAvatar(tx, 'author', 'skill')
  expect(database.marketplaceListing.updateMany).toHaveBeenCalledTimes(1)
})
