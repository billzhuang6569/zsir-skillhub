import type { Prisma } from '@prisma/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { canonicalJson, classicAvatarStyle, contentSha256 } from './avatar-style-catalog.js'
const mocks = vi.hoisted(() => ({ config: { SKILLHUB_PROFILE: 'yitan-official' }, user: vi.fn(), setting: vi.fn(), styles: vi.fn() }))
vi.mock('../config.js', () => ({ config: mocks.config }))
vi.mock('../db.js', () => ({ db: {} }))
vi.mock('./skill-avatars.js', () => ({ AvatarError: class extends Error { constructor(public statusCode: number, message: string, public code?: string) { super(message) } } }))
import { resolveAccountAvatarStyle } from './avatar-jobs.js'
const tx = { user: { findUniqueOrThrow: mocks.user }, serverSetting: { findUnique: mocks.setting }, avatarStyleVersion: { findMany: mocks.styles } } as unknown as Prisma.TransactionClient
beforeEach(() => {
  vi.clearAllMocks(); mocks.config.SKILLHUB_PROFILE = 'yitan-official'
  mocks.user.mockResolvedValue({ avatarStyleId: null }); mocks.setting.mockResolvedValue(null)
  mocks.styles.mockImplementation(async ({ where }: { where: { styleId: string } }) => {
    const content = canonicalJson({ ...classicAvatarStyle, styleId: where.styleId })
    return [{ styleId: where.styleId, styleVersion: 1, content, contentSha256: contentSha256(content), source: 'repository', createdAt: new Date() }]
  })
})
it('official resolves account, instance, then classic', async () => {
  expect((await resolveAccountAvatarStyle(tx, 'owner')).style.styleId).toBe('classic')
  mocks.setting.mockResolvedValue({ value: { styleId: 'instance' } })
  expect((await resolveAccountAvatarStyle(tx, 'owner')).style.styleId).toBe('instance')
  mocks.user.mockResolvedValue({ avatarStyleId: 'account' })
  expect((await resolveAccountAvatarStyle(tx, 'owner')).style.styleId).toBe('account')
})
it('selfhost ignores a persisted account preference', async () => {
  mocks.config.SKILLHUB_PROFILE = 'selfhost'
  mocks.user.mockResolvedValue({ avatarStyleId: 'account' })
  mocks.setting.mockResolvedValue({ value: { styleId: 'instance' } })
  const result = await resolveAccountAvatarStyle(tx, 'owner')
  expect(result.accountStyleId).toBeNull(); expect(result.style.styleId).toBe('instance')
})
it('rejects missing or corrupt styles instead of silently changing the intended style', async () => {
  mocks.styles.mockResolvedValue([])
  await expect(resolveAccountAvatarStyle(tx, 'owner')).rejects.toMatchObject({ code: 'AVATAR_STYLE_UNAVAILABLE', statusCode: 400 })
  mocks.styles.mockResolvedValue([{ styleId: 'classic', styleVersion: 1, content: canonicalJson(classicAvatarStyle), contentSha256: 'invalid' }])
  await expect(resolveAccountAvatarStyle(tx, 'owner')).rejects.toMatchObject({ code: 'AVATAR_STYLE_UNAVAILABLE' })
})
