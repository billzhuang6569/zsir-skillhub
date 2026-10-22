import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'

type RevocationCounts = {
  credentials: number
}

type LifecycleAuditInput = {
  requestId: string
  actorId: string
  teamId: string
  skillId?: string
  action: string
  reason: string
  counts: RevocationCounts
  targetUserId?: string
}

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,99}$/

export type DeclaredEnvDependency = {
  key: string
  description?: string
  required: boolean
}

/** Keys a Skill Profile declares; values are never part of the Profile. */
export function declaredEnvDependencies(value: Prisma.JsonValue): DeclaredEnvDependency[] {
  if (!Array.isArray(value)) return []
  const result = new Map<string, DeclaredEnvDependency>()
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.key !== 'string' || !ENV_KEY_PATTERN.test(record.key)) continue
    result.set(record.key, {
      key: record.key,
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      required: record.required !== false,
    })
  }
  return [...result.values()].sort((left, right) => left.key.localeCompare(right.key, 'en'))
}

export function isEnvKey(value: string): boolean {
  return ENV_KEY_PATTERN.test(value)
}

/**
 * Team keys belong to the team. Dissolving the team is the only lifecycle
 * event that revokes them; a member leaving or a Skill being unshared only
 * changes which Skills are in scope.
 */
export async function revokeTeamCredentialsForTeam(
  transaction: Prisma.TransactionClient,
  teamId: string,
  now: Date
): Promise<RevocationCounts> {
  const credentials = await transaction.teamCredential.updateMany({
    where: { teamId, status: 'active' },
    data: { status: 'revoked', revokedAt: now },
  })
  return { credentials: credentials.count }
}

export async function writeCredentialLifecycleAudit(
  transaction: Prisma.TransactionClient,
  input: LifecycleAuditInput
): Promise<void> {
  await transaction.credentialAuditEvent.create({
    data: {
      id: randomUUID(),
      requestId: input.requestId,
      actorId: input.actorId,
      teamId: input.teamId,
      skillId: input.skillId ?? null,
      action: input.action,
      outcome: 'success',
      reasonCode: input.reason,
      bindingIds: [],
      metadata: {
        revokedCredentialCount: input.counts.credentials,
        ...(input.targetUserId ? { targetUserId: input.targetUserId } : {}),
      },
    },
  })
}

type ScopeNotificationInput = {
  teamId: string
  teamName: string
  skillId: string
  skillName: string
  envDependencies: Prisma.JsonValue
}

/**
 * A Skill that has just been shared to a team enters the scope of every
 * active team key it declares by main name or alias (unless excluded). Each
 * holder gets one in-app notification naming the declared names, so they can stop it on the
 * key page. Returns the number of notifications written.
 */
export async function notifyTeamCredentialHoldersOfNewScope(
  transaction: Prisma.TransactionClient,
  input: ScopeNotificationInput
): Promise<number> {
  const keys = declaredEnvDependencies(input.envDependencies).map((dependency) => dependency.key)
  if (keys.length === 0) return 0
  const credentials = await transaction.teamCredential.findMany({
    where: {
      teamId: input.teamId,
      status: 'active',
      currentRevision: { gt: 0 },
      // A declared name matches a key by its main name or an alias (#288).
      OR: [
        { envKey: { in: keys } },
        { aliases: { some: { envKey: { in: keys } } } },
      ],
      exclusions: { none: { skillId: input.skillId } },
    },
    select: { envKey: true, createdById: true, aliases: { select: { envKey: true } } },
    orderBy: { envKey: 'asc' },
  })
  const declared = new Set(keys)
  const keysByHolder = new Map<string, string[]>()
  for (const credential of credentials) {
    const names = [credential.envKey, ...(credential.aliases ?? []).map((alias) => alias.envKey)]
      .filter((name) => declared.has(name))
    if (names.length === 0) continue
    keysByHolder.set(credential.createdById, [...(keysByHolder.get(credential.createdById) ?? []), ...names])
  }
  if (keysByHolder.size === 0) return 0
  await transaction.notification.createMany({
    data: [...keysByHolder.entries()].map(([userId, holderKeys]) => ({
      userId,
      type: 'team_key_scope_added',
      payload: {
        teamId: input.teamId,
        teamName: input.teamName,
        skillId: input.skillId,
        skillName: input.skillName,
        keys: holderKeys,
        message: `「${input.skillName}」已共享到「${input.teamName}」，会用到你放的 ${holderKeys.join('、')}。不想给它用可以在钥匙页停用。`,
      },
    })),
  })
  return keysByHolder.size
}
