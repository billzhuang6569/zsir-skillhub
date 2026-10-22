import { describe, expect, it } from 'vitest'
import { parseMarketplaceRoleOperation } from './marketplace-role-ops.js'

describe('Marketplace role operations', () => {
  it('accepts one explicit user id and administrator role', () => {
    expect(parseMarketplaceRoleOperation([
      '--user-id', '11111111-1111-4111-8111-111111111111',
      '--role', 'admin',
    ])).toEqual({
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'admin',
    })
  })

  it('normalizes an email and supports revoking the role', () => {
    expect(parseMarketplaceRoleOperation([
      '--email', ' Owner@Example.COM ',
      '--role', 'user',
    ])).toEqual({ email: 'owner@example.com', role: 'user' })
  })

  it.each([
    ['no selector', ['--role', 'admin']],
    ['both selectors', [
      '--user-id', '11111111-1111-4111-8111-111111111111',
      '--email', 'owner@example.com',
      '--role', 'admin',
    ]],
    ['invalid UUID', ['--user-id', '../../owner', '--role', 'admin']],
    ['invalid role', ['--email', 'owner@example.com', '--role', 'owner']],
    ['unknown option', ['--account', 'owner@example.com', '--role', 'admin']],
  ])('rejects %s', (_label, argv) => {
    expect(() => parseMarketplaceRoleOperation(argv)).toThrow()
  })
})
