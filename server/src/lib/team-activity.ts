import { Prisma } from '@prisma/client'

export const TEAM_ACTIVITY_TYPES = [
  'member_joined',
  'member_left',
  'member_removed',
  'skill_shared',
  'skill_unshared',
  'skill_version_published',
  'key_put',
  'key_rotated',
  'key_revoked',
] as const

export type TeamActivityType = (typeof TEAM_ACTIVITY_TYPES)[number]

/** Names and ids only. Values that could carry secrets are not representable. */
export type TeamActivityPayloadValue = string | number | boolean | null

export type TeamActivityPayload = Record<string, TeamActivityPayloadValue>

export type TeamActivityInput = {
  teamId: string
  actorId: string | null
  type: TeamActivityType
  payload: TeamActivityPayload
}

// Field names that must never land in an activity row, even by mistake.
const FORBIDDEN_PAYLOAD_FIELDS = new Set([
  'value',
  'ciphertext',
  'email',
  'token',
  'secret',
  'password',
  'wrappedKey',
  'nonce',
])

function sanitizedPayload(payload: TeamActivityPayload): Prisma.InputJsonObject {
  const result: Record<string, TeamActivityPayloadValue> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_PAYLOAD_FIELDS.has(key)) continue
    result[key] = value
  }
  return result
}

/**
 * Appends one team activity row inside the caller's transaction, so the feed
 * never shows something the business write rolled back.
 */
export async function recordTeamActivity(
  transaction: Prisma.TransactionClient,
  input: TeamActivityInput
): Promise<void> {
  await transaction.teamActivity.create({
    data: {
      teamId: input.teamId,
      actorId: input.actorId,
      type: input.type,
      payload: sanitizedPayload(input.payload),
    },
  })
}

/** Writes the same activity to several teams (e.g. a version published to a Skill shared with many teams). */
export async function recordTeamActivities(
  transaction: Prisma.TransactionClient,
  teamIds: readonly string[],
  input: Omit<TeamActivityInput, 'teamId'>
): Promise<void> {
  for (const teamId of new Set(teamIds)) {
    await recordTeamActivity(transaction, { ...input, teamId })
  }
}
