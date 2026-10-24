import { Prisma } from '@prisma/client'
import { db } from '../db.js'

// Explicit team wins; legacy callers use the first accessible team by ID.
export async function resolveTeamVersion(userId: string, skillId: string, teamId?: string, client: Prisma.TransactionClient = db): Promise<{ teamId: string; pinnedVersionId: string | null; version: Prisma.SkillVersionGetPayload<{ include: { aliases: true } }> } | null> {
  const share = await client.skillTeamShare.findFirst({
    where: { skillId, ...(teamId ? { teamId } : {}), skill: { deletedAt: null },
      team: { dissolvedAt: null, members: { some: { userId } } } },
    include: { skill: { select: { currentVersion: true } } },
    orderBy: { teamId: 'asc' },
  })
  if (!share) return null
  const version = await client.skillVersion.findFirst({
    where: { skillId, ...(share.versionId ? { id: share.versionId } : { version: share.skill.currentVersion }) },
    include: { aliases: true },
  })
  return version ? { teamId: share.teamId, pinnedVersionId: share.versionId ?? null, version } : null
}

export async function acquiredTeamRecipients(transaction: Prisma.TransactionClient, skillId: string, teamId: string, actorId: string): Promise<string[]> {
  const acquired = await transaction.teamSkillAcquisition.findMany({ where: { skillId, teamId }, select: { userId: true } })
  const members = await transaction.teamMember.findMany({
    where: { teamId, userId: { in: acquired.map(row => row.userId), not: actorId }, team: { dissolvedAt: null } },
    select: { userId: true },
  })
  return members.map(member => member.userId)
}

// Call before dissolving the team: recipients are its pre-dissolution members.
export async function notifyRemovedTeamShares(transaction: Prisma.TransactionClient, teamId: string, actorId: string, authorId?: string): Promise<void> {
  const shares = await transaction.skillTeamShare.findMany({ where: { teamId, ...(authorId ? { skill: { authorId } } : {}) },
    select: { skillId: true, skill: { select: { displayName: true } } } })
  for (const share of shares) {
    const recipients = await acquiredTeamRecipients(transaction, share.skillId, teamId, actorId)
    if (recipients.length) await transaction.notification.createMany({ data: recipients.map(userId => ({ userId, type: 'skill_unshared',
      payload: { skillId: share.skillId, teamId, skillName: share.skill.displayName } })) })
  }
}
