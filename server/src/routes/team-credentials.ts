import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import { decodeCredentialKek, encryptCredentialValue } from '../lib/credential-crypto.js'
import { declaredEnvDependencies } from '../lib/credential-lifecycle.js'
import { lockSkillTeamMutation, lockTeamMutation } from '../lib/mutation-lock.js'
import { authMiddleware } from '../middleware/auth.js'
import { recordTeamActivity } from '../lib/team-activity.js'

// Team key vault (#254). One encrypted value per (team, KEY). Every response
// here is metadata: no handler selects ciphertext, and plaintext only leaves
// the Server through POST /api/runtime/env.

const UuidSchema = z.string().uuid()
const EnvKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/)

const TeamParams = z.object({ teamId: UuidSchema })
const KeyParams = z.object({ teamId: UuidSchema, key: EnvKeySchema })
const ExclusionParams = z.object({ teamId: UuidSchema, key: EnvKeySchema, skillId: UuidSchema })
const PutBody = z.object({
  value: z.string().min(1).max(65_536).refine(
    (value) => !/[\0\r\n]/.test(value),
    'Credential value cannot contain NUL or line breaks'
  ),
}).strict()
// Aliases (#288): other variable names that resolve to the same team key.
const AliasesBody = z.object({
  aliases: z.array(EnvKeySchema).max(10),
}).strict()
const UsageQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
})

type Failure = { ok: false; statusCode: number; error: string; reasonCode?: string; key?: string }
type Success<T> = { ok: true; value: T }

type ActiveTeam = { id: string; name: string; ownerId: string }

type CredentialRow = {
  id: string
  teamId: string
  envKey: string
  status: string
  currentRevision: number
  createdById: string
}

function failure(statusCode: number, error: string): Failure {
  return { ok: false, statusCode, error }
}

function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store, private')
  reply.header('Pragma', 'no-cache')
}

function unavailable(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({ error: 'Team key service is temporarily unavailable' })
}

function aliasConflict(key: string, error: string): Failure {
  return { ok: false, statusCode: 409, error, reasonCode: 'alias_conflict', key }
}

function send<T>(reply: FastifyReply, result: Failure | Success<T>, statusCode = 200): FastifyReply {
  if (!result.ok) {
    return reply.code(result.statusCode).send({
      error: result.error,
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
      ...(result.key ? { key: result.key } : {}),
    })
  }
  return reply.code(statusCode).send(result.value)
}

async function audit(
  transaction: Prisma.TransactionClient,
  request: FastifyRequest,
  input: {
    teamId: string
    skillId?: string | null
    action: string
    outcome: 'success' | 'denied'
    reasonCode?: string | null
    credentialIds?: string[]
    metadata?: Record<string, string | number | boolean | null | string[]>
  }
): Promise<void> {
  await transaction.credentialAuditEvent.create({
    data: {
      id: randomUUID(),
      requestId: String(request.id),
      actorId: request.user.id,
      skillId: input.skillId ?? null,
      teamId: input.teamId,
      action: input.action,
      outcome: input.outcome,
      reasonCode: input.reasonCode ?? null,
      bindingIds: input.credentialIds ?? [],
      metadata: input.metadata ?? {},
    },
  })
}

/** Active membership of a non-dissolved team. */
async function activeTeamFor(
  client: Prisma.TransactionClient,
  teamId: string,
  userId: string
): Promise<ActiveTeam | null> {
  const membership = await client.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { team: { select: { id: true, name: true, ownerId: true, dissolvedAt: true } } },
  })
  if (!membership || membership.team.dissolvedAt) return null
  return { id: membership.team.id, name: membership.team.name, ownerId: membership.team.ownerId }
}

function canManage(team: ActiveTeam, credential: Pick<CredentialRow, 'createdById'>, userId: string): boolean {
  return credential.createdById === userId || team.ownerId === userId
}

async function activeCredential(
  client: Prisma.TransactionClient,
  teamId: string,
  envKey: string
): Promise<CredentialRow | null> {
  const credential = await client.teamCredential.findUnique({
    where: { teamId_envKey: { teamId, envKey } },
    select: { id: true, teamId: true, envKey: true, status: true, currentRevision: true, createdById: true },
  })
  return credential && credential.status === 'active' && credential.currentRevision > 0 ? credential : null
}

type LastUsedRow = { credentialId: string; lastUsedAt: Date }

async function lastUsedByCredential(credentialIds: string[]): Promise<Map<string, Date>> {
  if (credentialIds.length === 0) return new Map()
  const rows = await db.$queryRaw<LastUsedRow[]>`
    SELECT used."credentialId", MAX(event."createdAt") AS "lastUsedAt"
    FROM "credential_audit_events" AS event,
         jsonb_array_elements_text(event."bindingIds") AS used("credentialId")
    WHERE event."action" = 'runtime_env_resolve'
      AND event."outcome" = 'success'
      AND event."bindingIds" ?| ${credentialIds}::text[]
      AND used."credentialId" = ANY(${credentialIds}::text[])
    GROUP BY used."credentialId"
  `
  return new Map(rows.map((row) => [row.credentialId, row.lastUsedAt]))
}

type UsageRow = {
  actorId: string | null
  actorName: string | null
  skillId: string | null
  skillName: string | null
  count: number
  lastAt: Date
}

export const teamCredentialsRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.addHook('onRequest', async (_request, reply): Promise<void> => {
    noStore(reply)
  })
  fastify.addHook('onRequest', authMiddleware)

  // Metadata for the team tab of 「钥匙」: who holds each key, which Skills
  // may use it (shared to this team ∧ declare the key ∧ not excluded), the
  // exclusions and the last successful runtime use.
  fastify.get<{ Params: { teamId: string } }>('/:teamId/credentials', async (request: FastifyRequest<{ Params: { teamId: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const params = TeamParams.safeParse(request.params)
    if (!params.success) return reply.badRequest('Invalid team id')
    try {
      const team = await activeTeamFor(db, params.data.teamId, request.user.id)
      if (!team) return reply.code(403).send({ error: 'Active team membership required' })
      const [credentials, shares] = await Promise.all([
        db.teamCredential.findMany({
          where: { teamId: team.id, status: 'active', currentRevision: { gt: 0 } },
          select: {
            id: true,
            envKey: true,
            currentRevision: true,
            createdById: true,
            createdAt: true,
            updatedAt: true,
            createdBy: { select: { id: true, displayName: true } },
            exclusions: {
              select: { skillId: true, createdAt: true, skill: { select: { displayName: true } } },
              orderBy: { createdAt: 'asc' },
            },
            aliases: { select: { envKey: true }, orderBy: { envKey: 'asc' } },
          },
          orderBy: { envKey: 'asc' },
        }),
        db.skillTeamShare.findMany({
          where: { teamId: team.id, skill: { deletedAt: null } },
          select: { version: { select: { envDependencies: true } }, skill: { select: { id: true, displayName: true, envDependencies: true } } },
        }),
      ])
      const lastUsed = await lastUsedByCredential(credentials.map((credential) => credential.id))
      const declaring = shares.map((share) => ({
        id: share.skill.id,
        name: share.skill.displayName,
        keys: new Set(declaredEnvDependencies(share.version?.envDependencies ?? share.skill.envDependencies).map((dependency) => dependency.key)),
      }))
      return reply.send({
        teamId: team.id,
        teamName: team.name,
        isTeamOwner: team.ownerId === request.user.id,
        credentials: credentials.map((credential) => {
          const excluded = new Set(credential.exclusions.map((exclusion) => exclusion.skillId))
          const aliases = credential.aliases.map((alias) => alias.envKey).sort()
          // The main name wins when a Skill declares both it and an alias.
          const names = [credential.envKey, ...aliases]
          return {
            key: credential.envKey,
            aliases,
            holder: { id: credential.createdBy.id, displayName: credential.createdBy.displayName },
            revision: credential.currentRevision,
            createdAt: credential.createdAt,
            updatedAt: credential.updatedAt,
            canManage: canManage(team, credential, request.user.id),
            inScopeSkills: declaring
              .flatMap((skill) => {
                if (excluded.has(skill.id)) return []
                const declaredKey = names.find((name) => skill.keys.has(name))
                return declaredKey ? [{ id: skill.id, name: skill.name, declaredKey }] : []
              })
              .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN')),
            exclusions: credential.exclusions.map((exclusion) => ({
              skillId: exclusion.skillId,
              name: exclusion.skill.displayName,
              createdAt: exclusion.createdAt,
            })),
            lastUsedAt: lastUsed.get(credential.id) ?? null,
          }
        }),
      })
    } catch (error: unknown) {
      request.log.error({ err: error, action: 'team_credential_list', teamId: params.data.teamId }, 'Team key list failed')
      return unavailable(reply)
    }
  })

  // Any active member may put or rotate a team key. The writer becomes its
  // holder. The value is encrypted at rest and never echoed back.
  fastify.put<{ Params: { teamId: string; key: string } }>('/:teamId/credentials/:key', async (request: FastifyRequest<{ Params: { teamId: string; key: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const params = KeyParams.safeParse(request.params)
    if (!params.success) return reply.badRequest('Invalid team key')
    const body = PutBody.safeParse(request.body)
    if (!body.success) return reply.badRequest('Invalid team key value')
    if (Buffer.byteLength(body.data.value, 'utf8') > config.CREDENTIAL_MAX_VALUE_BYTES) {
      return reply.code(413).send({ error: 'Credential value is too large' })
    }
    let kek: Buffer
    try {
      kek = decodeCredentialKek(config.CREDENTIAL_KEK_BASE64)
    } catch (error: unknown) {
      request.log.error({ err: error, action: 'team_credential_write_keyring', teamId: params.data.teamId }, 'Credential KEK could not be loaded')
      return unavailable(reply)
    }
    const now = new Date()
    try {
      const result = await db.$transaction(async (transaction): Promise<Failure | Success<{ created: boolean; credential: Record<string, unknown> }>> => {
        await lockTeamMutation(transaction, params.data.teamId)
        const team = await activeTeamFor(transaction, params.data.teamId, request.user.id)
        if (!team) return failure(403, 'Active team membership required')
        const recentWrites = await transaction.credentialAuditEvent.count({
          where: {
            actorId: request.user.id,
            action: 'team_credential_write',
            outcome: 'success',
            createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) },
          },
        })
        if (recentWrites >= config.CREDENTIAL_WRITES_PER_HOUR) {
          await audit(transaction, request, {
            teamId: team.id,
            action: 'team_credential_write',
            outcome: 'denied',
            reasonCode: 'rate_limited',
            metadata: { envKey: params.data.key },
          })
          return failure(429, 'Too many credential updates. Try again later.')
        }
        const existing = await transaction.teamCredential.findUnique({
          where: { teamId_envKey: { teamId: team.id, envKey: params.data.key } },
          select: { id: true, currentRevision: true, status: true },
        })
        // A name belongs to at most one key per team: creating or restoring a
        // key cannot take a name that is already another active key's alias.
        const aliasOwner = await transaction.teamCredentialAlias.findFirst({
          where: {
            teamId: team.id,
            envKey: params.data.key,
            credential: { status: 'active' },
            ...(existing ? { credentialId: { not: existing.id } } : {}),
          },
          select: { credential: { select: { envKey: true } } },
        })
        if (aliasOwner) {
          await audit(transaction, request, {
            teamId: team.id,
            action: 'team_credential_write',
            outcome: 'denied',
            reasonCode: 'alias_conflict',
            metadata: { envKey: params.data.key },
          })
          return aliasConflict(
            params.data.key,
            `${params.data.key} 已经是团队钥匙 ${aliasOwner.credential.envKey} 的别名，请直接更新 ${aliasOwner.credential.envKey} 或先移除这个别名`
          )
        }
        const credentialId = existing?.id ?? randomUUID()
        const revision = (existing?.currentRevision ?? 0) + 1
        const encrypted = encryptCredentialValue(
          body.data.value,
          { credentialId, teamId: team.id, envKey: params.data.key, revision },
          kek,
          config.CREDENTIAL_KEK_VERSION
        )
        if (!existing) {
          await transaction.teamCredential.create({
            data: {
              id: credentialId,
              teamId: team.id,
              envKey: params.data.key,
              status: 'active',
              currentRevision: 0,
              createdById: request.user.id,
            },
          })
        }
        await transaction.teamCredentialVersion.create({
          data: { id: randomUUID(), credentialId, revision, ...encrypted, createdById: request.user.id },
        })
        const credential = await transaction.teamCredential.update({
          where: { id: credentialId },
          data: { currentRevision: revision, status: 'active', revokedAt: null, createdById: request.user.id },
          select: { envKey: true, teamId: true, currentRevision: true, createdById: true, updatedAt: true },
        })
        const operation = !existing ? 'create' : existing.status === 'active' ? 'rotate' : 'restore'
        await audit(transaction, request, {
          teamId: team.id,
          action: 'team_credential_write',
          outcome: 'success',
          credentialIds: [credentialId],
          metadata: {
            envKey: params.data.key,
            revision,
            operation,
          },
        })
        // Activity names the key and its holder only; never the value (#293).
        await recordTeamActivity(transaction, {
          teamId: team.id,
          actorId: request.user.id,
          type: operation === 'create' ? 'key_put' : 'key_rotated',
          payload: { envKey: credential.envKey, holderId: credential.createdById },
        })
        return {
          ok: true,
          value: {
            created: !existing,
            credential: {
              key: credential.envKey,
              teamId: credential.teamId,
              revision: credential.currentRevision,
              holderId: credential.createdById,
              updatedAt: credential.updatedAt,
            },
          },
        }
      })
      if (!result.ok) return send(reply, result)
      return reply.code(result.value.created ? 201 : 200).send(result.value.credential)
    } catch (error: unknown) {
      request.log.error({ err: error, action: 'team_credential_write', teamId: params.data.teamId }, 'Team key write failed')
      return unavailable(reply)
    } finally {
      kek.fill(0)
    }
  })

  // Holder or team owner revokes the key for the whole team.
  fastify.delete<{ Params: { teamId: string; key: string } }>('/:teamId/credentials/:key', async (request: FastifyRequest<{ Params: { teamId: string; key: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const params = KeyParams.safeParse(request.params)
    if (!params.success) return reply.badRequest('Invalid team key')
    try {
      const result = await db.$transaction(async (transaction): Promise<Failure | Success<null>> => {
        await lockTeamMutation(transaction, params.data.teamId)
        const team = await activeTeamFor(transaction, params.data.teamId, request.user.id)
        if (!team) return failure(403, 'Active team membership required')
        const credential = await activeCredential(transaction, team.id, params.data.key)
        if (!credential) return failure(404, 'Team key not found')
        if (!canManage(team, credential, request.user.id)) {
          await audit(transaction, request, {
            teamId: team.id,
            action: 'team_credential_revoke',
            outcome: 'denied',
            reasonCode: 'holder_or_owner_required',
            credentialIds: [credential.id],
          })
          return failure(403, 'Only the key holder or the team owner can revoke this key')
        }
        await transaction.teamCredential.update({
          where: { id: credential.id },
          data: { status: 'revoked', revokedAt: new Date() },
        })
        // Free the alias names; restoring the key starts without aliases.
        await transaction.teamCredentialAlias.deleteMany({ where: { credentialId: credential.id } })
        await audit(transaction, request, {
          teamId: team.id,
          action: 'team_credential_revoke',
          outcome: 'success',
          credentialIds: [credential.id],
          metadata: { envKey: credential.envKey },
        })
        await recordTeamActivity(transaction, {
          teamId: team.id,
          actorId: request.user.id,
          type: 'key_revoked',
          payload: { envKey: credential.envKey },
        })
        return { ok: true, value: null }
      })
      if (!result.ok) return send(reply, result)
      return reply.code(204).send()
    } catch (error: unknown) {
      request.log.error({ err: error, action: 'team_credential_revoke', teamId: params.data.teamId }, 'Team key revoke failed')
      return unavailable(reply)
    }
  })

  // Holder or team owner replaces the key's alias set. Within one team a
  // variable name belongs to at most one key (main name or alias).
  fastify.put<{ Params: { teamId: string; key: string } }>('/:teamId/credentials/:key/aliases', async (request: FastifyRequest<{ Params: { teamId: string; key: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const params = KeyParams.safeParse(request.params)
    if (!params.success) return reply.badRequest('Invalid team key')
    const body = AliasesBody.safeParse(request.body)
    if (!body.success) return reply.badRequest('Invalid team key aliases')
    const aliases = [...new Set(body.data.aliases)].sort()
    if (aliases.includes(params.data.key)) return reply.badRequest('An alias cannot equal the key name')
    try {
      const result = await db.$transaction(async (transaction): Promise<Failure | Success<{ key: string; teamId: string; aliases: string[] }>> => {
        await lockTeamMutation(transaction, params.data.teamId)
        const team = await activeTeamFor(transaction, params.data.teamId, request.user.id)
        if (!team) return failure(403, 'Active team membership required')
        const credential = await activeCredential(transaction, team.id, params.data.key)
        if (!credential) return failure(404, 'Team key not found')
        if (!canManage(team, credential, request.user.id)) {
          await audit(transaction, request, {
            teamId: team.id,
            action: 'team_credential_alias_write',
            outcome: 'denied',
            reasonCode: 'holder_or_owner_required',
            credentialIds: [credential.id],
          })
          return failure(403, 'Only the key holder or the team owner can change its aliases')
        }
        if (aliases.length > 0) {
          const mainNameOwner = await transaction.teamCredential.findFirst({
            where: { teamId: team.id, status: 'active', envKey: { in: aliases }, id: { not: credential.id } },
            select: { envKey: true },
            orderBy: { envKey: 'asc' },
          })
          const aliasOwner = mainNameOwner ? null : await transaction.teamCredentialAlias.findFirst({
            where: { teamId: team.id, envKey: { in: aliases }, credentialId: { not: credential.id } },
            select: { envKey: true, credential: { select: { envKey: true } } },
            orderBy: { envKey: 'asc' },
          })
          if (mainNameOwner || aliasOwner) {
            const clashing = mainNameOwner?.envKey ?? aliasOwner?.envKey ?? ''
            await audit(transaction, request, {
              teamId: team.id,
              action: 'team_credential_alias_write',
              outcome: 'denied',
              reasonCode: 'alias_conflict',
              credentialIds: [credential.id],
              metadata: { envKey: credential.envKey, conflictKey: clashing },
            })
            return aliasConflict(
              clashing,
              mainNameOwner
                ? `${clashing} 已经是团队里另一把钥匙的名字，不能再作为 ${credential.envKey} 的别名`
                : `${clashing} 已经是团队钥匙 ${aliasOwner?.credential.envKey ?? ''} 的别名，一个变量名只能属于一把钥匙`
            )
          }
        }
        const current = await transaction.teamCredentialAlias.findMany({
          where: { credentialId: credential.id },
          select: { envKey: true },
        })
        const currentNames = new Set(current.map((alias) => alias.envKey))
        await transaction.teamCredentialAlias.deleteMany({
          where: { credentialId: credential.id, envKey: { notIn: aliases } },
        })
        const added = aliases.filter((alias) => !currentNames.has(alias))
        if (added.length > 0) {
          await transaction.teamCredentialAlias.createMany({
            data: added.map((envKey) => ({ credentialId: credential.id, teamId: team.id, envKey, createdById: request.user.id })),
          })
        }
        await audit(transaction, request, {
          teamId: team.id,
          action: 'team_credential_alias_write',
          outcome: 'success',
          credentialIds: [credential.id],
          metadata: { envKey: credential.envKey, aliases },
        })
        return { ok: true, value: { key: credential.envKey, teamId: team.id, aliases } }
      })
      return send(reply, result)
    } catch (error: unknown) {
      request.log.error({ err: error, action: 'team_credential_alias_write', teamId: params.data.teamId }, 'Team key alias write failed')
      return unavailable(reply)
    }
  })

  const setExclusion = async (
    request: FastifyRequest<{ Params: { teamId: string; key: string; skillId: string } }>,
    reply: FastifyReply,
    excluded: boolean
  ): Promise<FastifyReply> => {
    const params = ExclusionParams.safeParse(request.params)
    if (!params.success) return reply.badRequest('Invalid team key exclusion')
    try {
      const result = await db.$transaction(async (transaction): Promise<Failure | Success<{ key: string; skillId: string; excluded: boolean }>> => {
        // Skill -> Team order matches runtime resolution, so an exclusion
        // that commits first is always seen by the next resolve.
        await lockSkillTeamMutation(transaction, params.data.skillId, params.data.teamId)
        const team = await activeTeamFor(transaction, params.data.teamId, request.user.id)
        if (!team) return failure(403, 'Active team membership required')
        const credential = await activeCredential(transaction, team.id, params.data.key)
        if (!credential) return failure(404, 'Team key not found')
        if (!canManage(team, credential, request.user.id)) {
          return failure(403, 'Only the key holder or the team owner can change its Skills')
        }
        const skill = await transaction.skill.findUnique({
          where: { id: params.data.skillId },
          select: { id: true, deletedAt: true },
        })
        if (!skill || skill.deletedAt) return failure(404, 'Skill not found')
        if (excluded) {
          await transaction.teamCredentialExclusion.upsert({
            where: { credentialId_skillId: { credentialId: credential.id, skillId: skill.id } },
            update: {},
            create: { credentialId: credential.id, skillId: skill.id, createdById: request.user.id },
          })
        } else {
          await transaction.teamCredentialExclusion.deleteMany({
            where: { credentialId: credential.id, skillId: skill.id },
          })
        }
        await audit(transaction, request, {
          teamId: team.id,
          skillId: skill.id,
          action: excluded ? 'team_credential_exclude' : 'team_credential_include',
          outcome: 'success',
          credentialIds: [credential.id],
          metadata: { envKey: credential.envKey },
        })
        return { ok: true, value: { key: credential.envKey, skillId: skill.id, excluded } }
      })
      return send(reply, result)
    } catch (error: unknown) {
      request.log.error({ err: error, action: 'team_credential_exclusion', teamId: params.data.teamId }, 'Team key exclusion failed')
      return unavailable(reply)
    }
  }

  fastify.put<{ Params: { teamId: string; key: string; skillId: string } }>(
    '/:teamId/credentials/:key/exclusions/:skillId',
    async (request: FastifyRequest<{ Params: { teamId: string; key: string; skillId: string } }>, reply: FastifyReply): Promise<FastifyReply> => setExclusion(request, reply, true)
  )
  fastify.delete<{ Params: { teamId: string; key: string; skillId: string } }>(
    '/:teamId/credentials/:key/exclusions/:skillId',
    async (request: FastifyRequest<{ Params: { teamId: string; key: string; skillId: string } }>, reply: FastifyReply): Promise<FastifyReply> => setExclusion(request, reply, false)
  )

  // Usage record: who used the key through which Skill, how often and when
  // (successful runtime resolutions only). Holder and team owner only.
  fastify.get<{ Params: { teamId: string; key: string } }>('/:teamId/credentials/:key/usage', async (request: FastifyRequest<{ Params: { teamId: string; key: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const params = KeyParams.safeParse(request.params)
    if (!params.success) return reply.badRequest('Invalid team key')
    const query = UsageQuery.safeParse(request.query)
    if (!query.success) return reply.badRequest('Invalid usage window')
    try {
      const team = await activeTeamFor(db, params.data.teamId, request.user.id)
      if (!team) return reply.code(403).send({ error: 'Active team membership required' })
      const credential = await activeCredential(db, team.id, params.data.key)
      if (!credential) return reply.code(404).send({ error: 'Team key not found' })
      if (!canManage(team, credential, request.user.id)) {
        return reply.code(403).send({ error: 'Only the key holder or the team owner can read its usage' })
      }
      const since = new Date(Date.now() - query.data.days * 24 * 60 * 60 * 1000)
      const rows = await db.$queryRaw<UsageRow[]>`
        SELECT event."actorId", actor."displayName" AS "actorName",
               event."skillId", skill."displayName" AS "skillName",
               COUNT(*)::int AS "count", MAX(event."createdAt") AS "lastAt"
        FROM "credential_audit_events" AS event
        LEFT JOIN "users" AS actor ON actor."id" = event."actorId"
        LEFT JOIN "skills" AS skill ON skill."id" = event."skillId"
        WHERE event."action" = 'runtime_env_resolve'
          AND event."outcome" = 'success'
          AND event."createdAt" >= ${since}
          AND event."bindingIds" @> jsonb_build_array(${credential.id}::text)
        GROUP BY event."actorId", actor."displayName", event."skillId", skill."displayName"
        ORDER BY MAX(event."createdAt") DESC
        LIMIT 200
      `
      return reply.send({
        key: credential.envKey,
        teamId: team.id,
        days: query.data.days,
        usage: rows.map((row) => ({
          actor: row.actorId ? { id: row.actorId, displayName: row.actorName ?? '' } : null,
          skill: row.skillId ? { id: row.skillId, name: row.skillName ?? '' } : null,
          count: Number(row.count),
          lastAt: row.lastAt,
        })),
      })
    } catch (error: unknown) {
      request.log.error({ err: error, action: 'team_credential_usage', teamId: params.data.teamId }, 'Team key usage read failed')
      return unavailable(reply)
    }
  })
}

// v0.29 clients still call the retired per-Skill binding API. Answer every
// method with 426 so they show an upgrade message instead of a generic error.
export const legacyCredentialsRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.addHook('onRequest', async (_request, reply): Promise<void> => {
    noStore(reply)
  })
  const upgrade = async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
    reply.code(426).send({
      error: '团队钥匙已升级为按团队共享，请升级 SkillHub 后在「钥匙」页管理',
      code: 'credential_api_retired',
    })
  fastify.all('/', upgrade)
  fastify.all('/*', upgrade)
}
