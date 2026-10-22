import type { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import {
  lockExternalIdentityMutation,
  lockSkillMutation,
  lockSkillTeamMutation,
  lockTeamMutation,
  lockUserMutation,
} from './mutation-lock.js'

function lockClient(keys: string[]): Pick<Prisma.TransactionClient, '$queryRaw'> {
  return {
    $queryRaw: vi.fn(async (_query: TemplateStringsArray, key: unknown) => {
      keys.push(String(key))
      return []
    }) as Prisma.TransactionClient['$queryRaw'],
  }
}

describe('PostgreSQL mutation advisory locks', () => {
  it('uses stable, namespaced lock keys', async () => {
    const keys: string[] = []
    const transaction = lockClient(keys)

    await lockSkillMutation(transaction, 'skill-001')
    await lockTeamMutation(transaction, 'team-001')

    expect(keys).toEqual([
      'skillhub:skill:skill-001',
      'skillhub:team:team-001',
    ])
  })

  it('always acquires Skill before Team for a combined scope', async () => {
    const keys: string[] = []

    await lockSkillTeamMutation(lockClient(keys), 'skill-001', 'team-001')

    expect(keys).toEqual([
      'skillhub:skill:skill-001',
      'skillhub:team:team-001',
    ])
  })

  it('serializes token-version changes with runtime credential reads', async () => {
    const keys: string[] = []

    await lockUserMutation(lockClient(keys), 'user-001')

    expect(keys).toEqual(['skillhub:user:user-001'])
  })

  it('serializes identity creation and logout by the same issuer and subject', async () => {
    const keys: string[] = []

    await lockExternalIdentityMutation(
      lockClient(keys),
      'https://account.example.test/realms/yitan',
      'central-user-001'
    )

    expect(keys).toEqual([
      'skillhub:external-identity:https://account.example.test/realms/yitan:central-user-001',
    ])
  })
})
