import { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import {
  declaredEnvDependencies,
  notifyTeamCredentialHoldersOfNewScope,
  revokeTeamCredentialsForTeam,
  writeCredentialLifecycleAudit,
} from './credential-lifecycle.js'

function transactionMock() {
  return {
    teamCredential: {
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    notification: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    credentialAuditEvent: { create: vi.fn().mockResolvedValue({ id: 'audit-001' }) },
  }
}

function asTransaction(value: ReturnType<typeof transactionMock>): Prisma.TransactionClient {
  return value as unknown as Prisma.TransactionClient
}

describe('team credential lifecycle', () => {
  it('revokes every active team key when a team is dissolved', async () => {
    const transaction = transactionMock()
    const now = new Date('2026-10-13T00:00:00.000Z')
    await expect(revokeTeamCredentialsForTeam(asTransaction(transaction), 'team-001', now)).resolves.toEqual({ credentials: 2 })
    expect(transaction.teamCredential.updateMany).toHaveBeenCalledWith({
      where: { teamId: 'team-001', status: 'active' },
      data: { status: 'revoked', revokedAt: now },
    })
  })

  it('persists lifecycle audit metadata without credential values', async () => {
    const transaction = transactionMock()
    await writeCredentialLifecycleAudit(asTransaction(transaction), {
      requestId: 'request-001',
      actorId: 'owner-001',
      teamId: 'team-001',
      action: 'credential_lifecycle_team_dissolve',
      reason: 'team_dissolved',
      counts: { credentials: 2 },
    })
    expect(transaction.credentialAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestId: 'request-001',
        actorId: 'owner-001',
        teamId: 'team-001',
        skillId: null,
        action: 'credential_lifecycle_team_dissolve',
        outcome: 'success',
        reasonCode: 'team_dissolved',
        bindingIds: [],
        metadata: { revokedCredentialCount: 2 },
      }),
    })
  })

  it('parses declared keys and ignores invalid names', () => {
    expect(declaredEnvDependencies([
      { key: 'FAL_KEY', description: 'fal', required: true },
      { key: 'lower_case' },
      { key: 'OPTIONAL_KEY', required: false },
      'NOT_AN_OBJECT',
    ])).toEqual([
      { key: 'FAL_KEY', description: 'fal', required: true },
      { key: 'OPTIONAL_KEY', required: false },
    ])
    expect(declaredEnvDependencies(null)).toEqual([])
  })

  it('notifies each holder once when a shared Skill enters their keys\' scope', async () => {
    const transaction = transactionMock()
    transaction.teamCredential.findMany.mockResolvedValue([
      { envKey: 'FAL_KEY', createdById: 'holder-a' },
      { envKey: 'OPENAI_API_KEY', createdById: 'holder-a' },
      { envKey: 'HF_TOKEN', createdById: 'holder-b' },
    ])
    await expect(notifyTeamCredentialHoldersOfNewScope(asTransaction(transaction), {
      teamId: 'team-001',
      teamName: '产品组',
      skillId: 'skill-001',
      skillName: '生图',
      envDependencies: [{ key: 'FAL_KEY' }, { key: 'OPENAI_API_KEY' }, { key: 'HF_TOKEN' }],
    })).resolves.toBe(2)
    expect(transaction.teamCredential.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        teamId: 'team-001',
        status: 'active',
        currentRevision: { gt: 0 },
        OR: [
          { envKey: { in: ['FAL_KEY', 'HF_TOKEN', 'OPENAI_API_KEY'] } },
          { aliases: { some: { envKey: { in: ['FAL_KEY', 'HF_TOKEN', 'OPENAI_API_KEY'] } } } },
        ],
        exclusions: { none: { skillId: 'skill-001' } },
      },
    }))
    const data = transaction.notification.createMany.mock.calls[0]?.[0]?.data as Array<{ userId: string; type: string; payload: Record<string, unknown> }>
    expect(data.map((item) => item.userId)).toEqual(['holder-a', 'holder-b'])
    expect(data[0]?.type).toBe('team_key_scope_added')
    expect(data[0]?.payload).toMatchObject({
      teamId: 'team-001',
      teamName: '产品组',
      skillId: 'skill-001',
      skillName: '生图',
      keys: ['FAL_KEY', 'OPENAI_API_KEY'],
      message: '「生图」已共享到「产品组」，会用到你放的 FAL_KEY、OPENAI_API_KEY。不想给它用可以在钥匙页停用。',
    })
    expect(data[1]?.payload.message).toBe('「生图」已共享到「产品组」，会用到你放的 HF_TOKEN。不想给它用可以在钥匙页停用。')
  })

  it('notifies the holder when the Skill declares an alias of their key, naming the declared name', async () => {
    const transaction = transactionMock()
    transaction.teamCredential.findMany.mockResolvedValue([
      { envKey: 'FAL_KEY', createdById: 'holder-a', aliases: [{ envKey: 'FAL_API_KEY' }, { envKey: 'FAL_TOKEN' }] },
    ])
    await expect(notifyTeamCredentialHoldersOfNewScope(asTransaction(transaction), {
      teamId: 'team-001',
      teamName: '产品组',
      skillId: 'skill-001',
      skillName: '生图',
      envDependencies: [{ key: 'FAL_API_KEY' }],
    })).resolves.toBe(1)
    const data = transaction.notification.createMany.mock.calls[0]?.[0]?.data as Array<{ userId: string; payload: Record<string, unknown> }>
    expect(data).toHaveLength(1)
    expect(data[0]?.userId).toBe('holder-a')
    expect(data[0]?.payload).toMatchObject({ keys: ['FAL_API_KEY'] })
    expect(String(data[0]?.payload.message)).toContain('FAL_API_KEY')
  })

  it('writes nothing when the Skill declares no key the team holds', async () => {
    const transaction = transactionMock()
    await expect(notifyTeamCredentialHoldersOfNewScope(asTransaction(transaction), {
      teamId: 'team-001', teamName: 'T', skillId: 'skill-001', skillName: 'S', envDependencies: [],
    })).resolves.toBe(0)
    expect(transaction.teamCredential.findMany).not.toHaveBeenCalled()
    expect(transaction.notification.createMany).not.toHaveBeenCalled()
  })
})
