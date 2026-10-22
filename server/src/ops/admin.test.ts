import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyPassword } from '../lib/password.js'

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(), user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
}))
const lockUser = vi.hoisted(() => vi.fn())
vi.mock('../db.js', () => ({ db: mockDb }))
vi.mock('../lib/mutation-lock.js', () => ({ lockUserMutation: lockUser }))
import { runAdmin } from './admin.js'

describe('admin reset-password', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockDb.$transaction.mockImplementation(async (callback: (client: typeof mockDb) => Promise<unknown>): Promise<unknown> => callback(mockDb))
    mockDb.user.findUnique.mockResolvedValue({ id: 'user-1' })
    mockDb.user.findUniqueOrThrow.mockResolvedValue({ passwordHash: 'old-hash', passwordSalt: 'old-salt' })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('replaces the password, revokes sessions, and prints the new password once after commit', async (): Promise<void> => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await runAdmin(['reset-password', '--email', ' USER@Example.com '])
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({ where: { email: 'user@example.com' }, select: { id: true } })
    expect(lockUser).toHaveBeenCalledWith(mockDb, 'user-1')
    expect(output).toHaveBeenCalledTimes(1)
    const message = String(output.mock.calls[0]?.[0])
    const password = message.match(/新密码：([A-Za-z0-9_-]{32})/)?.[1]
    expect(password).toBeDefined()
    expect(message).toContain('登录后立即修改密码')
    const update = mockDb.user.update.mock.calls[0]?.[0]
    expect(update).toEqual({ where: { id: 'user-1' }, data: {
      passwordHash: expect.any(String), passwordSalt: expect.any(String), tokenVersion: { increment: 1 },
    } })
    expect(await verifyPassword(password!, update.data.passwordHash, update.data.passwordSalt)).toBe(true)
    expect(JSON.stringify(update)).not.toContain(password)
    expect(mockDb.$transaction.mock.invocationCallOrder[0]).toBeLessThan(output.mock.invocationCallOrder[0]!)
  })

  it.each([{ passwordHash: null, passwordSalt: null }, { passwordHash: 'hash', passwordSalt: null }])('refuses users without local password support: %j', async (user): Promise<void> => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    mockDb.user.findUniqueOrThrow.mockResolvedValue(user)
    await expect(runAdmin(['reset-password', '--email', 'user@example.com'])).rejects.toThrow('no local password')
    expect(mockDb.user.update).not.toHaveBeenCalled()
    expect(output).not.toHaveBeenCalled()
  })

  it('prints no password if the transaction fails', async (): Promise<void> => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    mockDb.user.update.mockRejectedValue(new Error('database failure'))
    await expect(runAdmin(['reset-password', '--email', 'user@example.com'])).rejects.toThrow()
    expect(output).not.toHaveBeenCalled()
  })

  it('rejects unknown accounts', async (): Promise<void> => {
    mockDb.user.findUnique.mockResolvedValue(null)
    await expect(runAdmin(['reset-password', '--email', 'user@example.com'])).rejects.toThrow('not found')
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it.each([[], ['reset-password', '--email', 'bad'], ['reset-password', '--email', 'a@b.com', '--extra'], ['unknown', '--email', 'a@b.com']])('validates arguments %j', async (...argv): Promise<void> => {
    await expect(runAdmin(argv)).rejects.toThrow('Usage:')
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })
})
