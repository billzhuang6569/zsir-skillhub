import { Prisma } from '@prisma/client'

type AdvisoryLockClient = Pick<Prisma.TransactionClient, '$queryRaw'>

async function acquireMutationLock(
  transaction: AdvisoryLockClient,
  lockKey: string
): Promise<void> {
  // PostgreSQL releases transaction-level advisory locks automatically on
  // commit/rollback. A 64-bit server-side hash keeps UUID-sized identifiers
  // parameterized while giving every SkillHub mutation namespace one lock key.
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS lock_result
  `
}

export async function lockSkillMutation(
  transaction: AdvisoryLockClient,
  skillId: string
): Promise<void> {
  await acquireMutationLock(transaction, `skillhub:skill:${skillId}`)
}

export async function lockMarketplaceTopicMutation(transaction: AdvisoryLockClient, topicId: string): Promise<void> {
  await acquireMutationLock(transaction, `skillhub:marketplace-topic:${topicId}`)
}

export async function lockTeamMutation(
  transaction: AdvisoryLockClient,
  teamId: string
): Promise<void> {
  await acquireMutationLock(transaction, `skillhub:team:${teamId}`)
}

export async function lockUserMutation(
  transaction: AdvisoryLockClient,
  userId: string
): Promise<void> {
  await acquireMutationLock(transaction, `skillhub:user:${userId}`)
}

export async function lockExternalIdentityMutation(
  transaction: AdvisoryLockClient,
  issuer: string,
  subject: string
): Promise<void> {
  await acquireMutationLock(transaction, `skillhub:external-identity:${issuer}:${subject}`)
}

export async function lockSkillTeamMutation(
  transaction: AdvisoryLockClient,
  skillId: string,
  teamId: string
): Promise<void> {
  // Global multi-scope order is ExternalIdentity -> User -> Skill -> Team.
  // Callers that also need ExternalIdentity/User acquire those before entering
  // this helper; Team lifecycle writers only acquire Team, so no cycle forms.
  await lockSkillMutation(transaction, skillId)
  await lockTeamMutation(transaction, teamId)
}
