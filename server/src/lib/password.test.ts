import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password.js'

describe('password credentials', () => {
  it('uses a random salt and verifies without storing the plain password', async () => {
    const first = await hashPassword('correct horse battery staple')
    const second = await hashPassword('correct horse battery staple')

    expect(first.passwordHash).not.toBe('correct horse battery staple')
    expect(first.passwordSalt).not.toBe(second.passwordSalt)
    expect(first.passwordHash).not.toBe(second.passwordHash)
    await expect(verifyPassword('correct horse battery staple', first.passwordHash, first.passwordSalt)).resolves.toBe(true)
    await expect(verifyPassword('wrong password', first.passwordHash, first.passwordSalt)).resolves.toBe(false)
  })

  it('performs a safe negative check when credentials are absent or malformed', async () => {
    await expect(verifyPassword('not-the-password', null, null)).resolves.toBe(false)
    await expect(verifyPassword('not-the-password', 'invalid', 'invalid')).resolves.toBe(false)
  })
})
