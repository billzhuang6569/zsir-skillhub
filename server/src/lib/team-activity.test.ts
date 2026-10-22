import { describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { recordTeamActivities, recordTeamActivity, TEAM_ACTIVITY_TYPES } from './team-activity.js'

function transactionMock(): { teamActivity: { create: ReturnType<typeof vi.fn> } } {
  return { teamActivity: { create: vi.fn().mockResolvedValue({}) } }
}

function asTransaction(value: ReturnType<typeof transactionMock>): Prisma.TransactionClient {
  return value as unknown as Prisma.TransactionClient
}

describe('team activity', () => {
  it('lists every activity type the feed understands', () => {
    expect(TEAM_ACTIVITY_TYPES).toEqual([
      'member_joined',
      'member_left',
      'member_removed',
      'skill_shared',
      'skill_unshared',
      'skill_version_published',
      'key_put',
      'key_rotated',
      'key_revoked',
    ])
  })

  it('writes one row with the actor, type and payload in the caller transaction', async () => {
    const transaction = transactionMock()
    await recordTeamActivity(asTransaction(transaction), {
      teamId: 'team-001',
      actorId: 'user-001',
      type: 'key_put',
      payload: { envKey: 'FAL_KEY', holderId: 'user-001' },
    })
    expect(transaction.teamActivity.create).toHaveBeenCalledOnce()
    expect(transaction.teamActivity.create).toHaveBeenCalledWith({
      data: {
        teamId: 'team-001',
        actorId: 'user-001',
        type: 'key_put',
        payload: { envKey: 'FAL_KEY', holderId: 'user-001' },
      },
    })
  })

  it('accepts a null actor', async () => {
    const transaction = transactionMock()
    await recordTeamActivity(asTransaction(transaction), {
      teamId: 'team-001', actorId: null, type: 'member_left', payload: { userId: 'user-002' },
    })
    expect(transaction.teamActivity.create).toHaveBeenCalledWith({
      data: { teamId: 'team-001', actorId: null, type: 'member_left', payload: { userId: 'user-002' } },
    })
  })

  it('drops fields that could carry secrets or personal contact data', async () => {
    const transaction = transactionMock()
    await recordTeamActivity(asTransaction(transaction), {
      teamId: 'team-001',
      actorId: 'user-001',
      type: 'key_rotated',
      payload: {
        envKey: 'FAL_KEY',
        value: 'secret',
        ciphertext: 'abc',
        email: 'a@example.com',
        token: 't',
      },
    })
    const payload = (transaction.teamActivity.create.mock.calls[0]?.[0] as { data: { payload: Record<string, unknown> } }).data.payload
    expect(payload).toEqual({ envKey: 'FAL_KEY' })
  })

  it('writes one row per distinct team', async () => {
    const transaction = transactionMock()
    await recordTeamActivities(asTransaction(transaction), ['team-001', 'team-002', 'team-001'], {
      actorId: 'user-001',
      type: 'skill_version_published',
      payload: { skillId: 'skill-001', skillName: '周报助手', version: '2.0.0' },
    })
    expect(transaction.teamActivity.create).toHaveBeenCalledTimes(2)
    expect(transaction.teamActivity.create.mock.calls.map((call) => (call[0] as { data: { teamId: string } }).data.teamId))
      .toEqual(['team-001', 'team-002'])
  })

  it('writes nothing for no teams', async () => {
    const transaction = transactionMock()
    await recordTeamActivities(asTransaction(transaction), [], {
      actorId: 'user-001', type: 'skill_version_published', payload: { skillId: 'skill-001' },
    })
    expect(transaction.teamActivity.create).not.toHaveBeenCalled()
  })
})
