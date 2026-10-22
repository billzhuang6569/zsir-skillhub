import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import {
  decodeCredentialKekKeyring,
  decryptCredentialValue,
  destroyCredentialKekKeyring,
} from '../lib/credential-crypto.js'
import { lockSkillTeamMutation, lockUserMutation } from '../lib/mutation-lock.js'
import { authMiddleware } from '../middleware/auth.js'

const UuidSchema = z.string().uuid()
const EnvKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/)

const OptionsQuery = z.object({ skillId: UuidSchema })
const RuntimeSourceSchema = z.object({
  key: EnvKeySchema,
  teamId: UuidSchema,
})
const ResolveBody = z.object({
  skillId: UuidSchema,
  sources: z.array(RuntimeSourceSchema).max(100).refine(
    (sources) => new Set(sources.map((source) => source.key)).size === sources.length,
    'Runtime source keys must be unique'
  ),
})

type EnvDependency = {
  key: string
  description?: string
  required: boolean
}

type RouteFailure = { ok: false; statusCode: number; error: string; reasonCode: string }
type RouteSuccess<T> = { ok: true; value: T }

function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store, private')
  reply.header('Pragma', 'no-cache')
}

function unavailable(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({ error: 'Runtime environment service is temporarily unavailable' })
}

function dependencies(value: Prisma.JsonValue): EnvDependency[] {
  if (!Array.isArray(value)) return []
  const result: EnvDependency[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.key !== 'string' || !EnvKeySchema.safeParse(record.key).success) continue
    result.push({
      key: record.key,
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      required: record.required !== false,
    })
  }
  return result.sort((left, right) => left.key.localeCompare(right.key, 'en'))
}

async function writeAudit(
  transaction: Prisma.TransactionClient,
  request: FastifyRequest,
  input: {
    actorId?: string | null
    skillId?: string | null
    teamId?: string | null
    outcome: 'success' | 'denied' | 'error'
    reasonCode?: string | null
    bindingIds?: string[]
    metadata?: Record<string, string | number | boolean | null>
  }
): Promise<void> {
  await transaction.credentialAuditEvent.create({
    data: {
      id: randomUUID(),
      requestId: String(request.id),
      actorId: input.actorId === undefined ? request.user.id : input.actorId,
      skillId: input.skillId ?? null,
      teamId: input.teamId ?? null,
      action: 'runtime_env_resolve',
      outcome: input.outcome,
      reasonCode: input.reasonCode ?? null,
      bindingIds: input.bindingIds ?? [],
      metadata: input.metadata ?? {},
    },
  })
}

async function canAccessSkill(
  transaction: Prisma.TransactionClient,
  userId: string,
  skillId: string,
  authorId: string
): Promise<boolean> {
  if (authorId === userId) return true
  const share = await transaction.skillTeamShare.findFirst({
    where: {
      skillId,
      team: {
        dissolvedAt: null,
        members: { some: { userId } },
      },
    },
    select: { skillId: true },
  })
  return share !== null
}

export const runtimeRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  fastify.addHook('onRequest', async (_request, reply): Promise<void> => {
    noStore(reply)
  })
  fastify.addHook('onRequest', authMiddleware)

  // Metadata only. The desktop combines these live team keys with the local
  // vault / override values using the fixed resolution order.
  fastify.get('/env/options', async (request, reply) => {
    const query = OptionsQuery.safeParse(request.query)
    if (!query.success) return reply.badRequest('Invalid runtime environment query')
    try {
      const skill = await db.skill.findUnique({
        where: { id: query.data.skillId },
        select: { id: true, authorId: true, envDependencies: true, deletedAt: true },
      })
      if (!skill || skill.deletedAt) return reply.code(404).send({ error: 'Skill not found' })
      if (!await canAccessSkill(db, request.user.id, skill.id, skill.authorId)) {
        return reply.code(403).send({ error: 'Skill access is no longer available' })
      }
      const declared = dependencies(skill.envDependencies)
      const declaredKeys = new Set(declared.map((dependency) => dependency.key))
      // A team key is a source for this Skill only while the account is an
      // active member, the Skill is shared to that team, declares the key
      // and is not excluded by the key's holder or the team owner.
      // A key matches by its main name or any alias (#288); each match is
      // offered under the name the Skill declares.
      const declaredList = [...declaredKeys]
      const credentials = await db.teamCredential.findMany({
        where: {
          status: 'active',
          currentRevision: { gt: 0 },
          OR: [
            { envKey: { in: declaredList } },
            { aliases: { some: { envKey: { in: declaredList } } } },
          ],
          exclusions: { none: { skillId: skill.id } },
          team: {
            dissolvedAt: null,
            members: { some: { userId: request.user.id } },
            skillShares: { some: { skillId: skill.id } },
          },
        },
        select: {
          envKey: true,
          teamId: true,
          currentRevision: true,
          team: { select: { name: true } },
          aliases: { select: { envKey: true } },
        },
        orderBy: [{ envKey: 'asc' }, { teamId: 'asc' }],
      })
      const sources = credentials.flatMap((credential) =>
        [credential.envKey, ...(credential.aliases ?? []).map((alias) => alias.envKey)]
          .filter((name) => declaredKeys.has(name))
          .map((name) => ({
            key: name,
            teamId: credential.teamId,
            teamName: credential.team.name,
            revision: credential.currentRevision,
          }))
      ).sort((left, right) => left.key.localeCompare(right.key, 'en') || left.teamId.localeCompare(right.teamId, 'en'))
      return reply.send({
        skillId: skill.id,
        dependencies: declared,
        sources,
      })
    } catch (error: unknown) {
      request.log.error(
        { err: error, action: 'runtime_env_options', skillId: query.data.skillId },
        'Runtime environment options failed'
      )
      return unavailable(reply)
    }
  })

  // Resolve only the explicitly selected team sources. Personal values stay
  // on the Mac and are never uploaded. No device proof or native confirmation
  // is involved: a valid account session plus current Team access is enough.
  fastify.post('/env', async (request, reply) => {
    const body = ResolveBody.safeParse(request.body)
    if (!body.success) return reply.badRequest('Invalid runtime environment request')
    const verifiedAuthToken = request.verifiedAuthToken
    if (
      !verifiedAuthToken
      || verifiedAuthToken.sub !== request.user.id
      || !Number.isInteger(verifiedAuthToken.ver)
    ) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    let keyring: Map<number, Buffer>
    try {
      keyring = decodeCredentialKekKeyring(
        config.CREDENTIAL_KEK_BASE64,
        config.CREDENTIAL_KEK_VERSION,
        config.CREDENTIAL_KEK_KEYRING_JSON
      )
    } catch (error: unknown) {
      request.log.error(
        { err: error, action: 'runtime_env_keyring', skillId: body.data.skillId },
        'Runtime credential KEK keyring could not be loaded'
      )
      return unavailable(reply)
    }

    try {
      const result = await db.$transaction(async (transaction): Promise<
        RouteFailure | RouteSuccess<{
          dependencies: EnvDependency[]
          credentials: Array<{ key: string; value: string; teamId: string }>
        }>
      > => {
        await lockUserMutation(transaction, request.user.id)
        // Authentication's first token-version read happens before this
        // transaction. Re-check after acquiring the same User advisory lock
        // used by logout and password changes so a revocation that won the
        // lock can never be followed by credential decryption in this request.
        const lockedUser = await transaction.user.findUnique({
          where: { id: request.user.id },
          select: { tokenVersion: true },
        })
        if (!lockedUser || lockedUser.tokenVersion !== verifiedAuthToken.ver) {
          await writeAudit(transaction, request, {
            actorId: lockedUser ? request.user.id : null,
            outcome: 'denied',
            reasonCode: 'session_revoked',
          })
          return {
            ok: false,
            statusCode: 401,
            error: 'Unauthorized',
            reasonCode: 'session_revoked',
          }
        }
        const recentResolves = await transaction.credentialAuditEvent.count({
          where: {
            actorId: request.user.id,
            action: 'runtime_env_resolve',
            createdAt: { gte: new Date(Date.now() - 60 * 1000) },
          },
        })
        if (recentResolves >= config.RUNTIME_ENV_FETCHES_PER_MINUTE) {
          await writeAudit(transaction, request, {
            skillId: body.data.skillId,
            outcome: 'denied',
            reasonCode: 'rate_limited',
          })
          return { ok: false, statusCode: 429, error: 'Too many environment fetches. Try again later.', reasonCode: 'rate_limited' }
        }

        const teamIds = [...new Set(body.data.sources.map((source) => source.teamId))].sort()
        for (const teamId of teamIds) {
          await lockSkillTeamMutation(transaction, body.data.skillId, teamId)
        }
        const skill = await transaction.skill.findUnique({
          where: { id: body.data.skillId },
          select: { id: true, authorId: true, envDependencies: true, deletedAt: true },
        })
        if (!skill || skill.deletedAt) {
          await writeAudit(transaction, request, {
            outcome: 'denied',
            reasonCode: 'skill_not_found',
          })
          return { ok: false, statusCode: 404, error: 'Skill not found', reasonCode: 'skill_not_found' }
        }
        if (!await canAccessSkill(transaction, request.user.id, skill.id, skill.authorId)) {
          await writeAudit(transaction, request, {
            skillId: skill.id,
            outcome: 'denied',
            reasonCode: 'skill_access_required',
          })
          return { ok: false, statusCode: 403, error: 'Skill access is no longer available', reasonCode: 'skill_access_required' }
        }

        const declared = dependencies(skill.envDependencies)
        const declaredKeys = new Set(declared.map((dependency) => dependency.key))
        if (body.data.sources.some((source) => !declaredKeys.has(source.key))) {
          await writeAudit(transaction, request, {
            skillId: skill.id,
            outcome: 'denied',
            reasonCode: 'env_dependency_required',
          })
          return { ok: false, statusCode: 409, error: 'Environment key is not declared by the Skill Profile', reasonCode: 'env_dependency_required' }
        }

        if (body.data.sources.length === 0) {
          await writeAudit(transaction, request, {
            skillId: skill.id,
            outcome: 'success',
            metadata: { keyCount: 0, teamCount: 0 },
          })
          return { ok: true, value: { dependencies: declared, credentials: [] } }
        }

        const memberships = await transaction.teamMember.findMany({
          where: {
            userId: request.user.id,
            teamId: { in: teamIds },
            team: { dissolvedAt: null },
          },
          select: { teamId: true },
        })
        const membershipIds = new Set(memberships.map((membership) => membership.teamId))
        const shares = await transaction.skillTeamShare.findMany({
          where: { skillId: skill.id, teamId: { in: teamIds } },
          select: { teamId: true },
        })
        const shareIds = new Set(shares.map((share) => share.teamId))
        if (teamIds.some((teamId) => !membershipIds.has(teamId) || !shareIds.has(teamId))) {
          await writeAudit(transaction, request, {
            skillId: skill.id,
            outcome: 'denied',
            reasonCode: 'team_source_unavailable',
            metadata: { teamCount: teamIds.length },
          })
          return { ok: false, statusCode: 409, error: 'A selected Team source is no longer available', reasonCode: 'team_source_unavailable' }
        }

        // `source.key` is the name the Skill declares: the key's main name or
        // one of its aliases (#288). Either way the value is served under it.
        const teamCredentials = await transaction.teamCredential.findMany({
          where: {
            status: 'active',
            OR: body.data.sources.map((source) => ({
              teamId: source.teamId,
              OR: [{ envKey: source.key }, { aliases: { some: { envKey: source.key } } }],
            })),
          },
          select: {
            id: true,
            envKey: true,
            teamId: true,
            currentRevision: true,
            exclusions: { where: { skillId: skill.id }, select: { skillId: true } },
            aliases: { select: { envKey: true } },
          },
        })
        const credentialBySource = new Map<string, (typeof teamCredentials)[number]>()
        for (const credential of teamCredentials) {
          for (const alias of credential.aliases ?? []) {
            credentialBySource.set(`${alias.envKey}\0${credential.teamId}`, credential)
          }
        }
        // A main name always wins over a (stale) alias of the same name.
        for (const credential of teamCredentials) {
          credentialBySource.set(`${credential.envKey}\0${credential.teamId}`, credential)
        }
        const selected = body.data.sources.map((source) => ({
          source,
          credential: credentialBySource.get(`${source.key}\0${source.teamId}`),
        }))
        const uniqueIds = (items: Array<{ id: string }>): string[] => [...new Set(items.map((item) => item.id))]
        const excluded = selected.flatMap((item) => item.credential && item.credential.exclusions.length > 0 ? [item] : [])
        if (excluded.length > 0) {
          await writeAudit(transaction, request, {
            skillId: skill.id,
            outcome: 'denied',
            reasonCode: 'team_key_excluded',
            bindingIds: uniqueIds(excluded.flatMap((item) => item.credential ? [item.credential] : [])),
          })
          return {
            ok: false,
            statusCode: 409,
            error: `团队已不再允许这个 Skill 使用 ${excluded.map((item) => item.source.key).join('、')}，请联系钥匙持有人或改用自己的钥匙`,
            reasonCode: 'team_key_excluded',
          }
        }
        if (selected.some((item) => !item.credential || item.credential.currentRevision < 1)) {
          await writeAudit(transaction, request, {
            skillId: skill.id,
            outcome: 'denied',
            reasonCode: 'team_source_unavailable',
            bindingIds: uniqueIds(selected.flatMap((item) => item.credential ? [item.credential] : [])),
          })
          return { ok: false, statusCode: 409, error: 'A selected Team source is no longer available', reasonCode: 'team_source_unavailable' }
        }

        const servedSources = selected.flatMap((item) => item.credential ? [{ key: item.source.key, credential: item.credential }] : [])
        const concrete = [...new Map(servedSources.map((item) => [item.credential.id, item.credential])).values()]
        const versions = await transaction.teamCredentialVersion.findMany({
          where: {
            OR: concrete.map((credential) => ({
              credentialId: credential.id,
              revision: credential.currentRevision,
            })),
          },
        })
        const versionsByCredential = new Map(versions.map((version) => [version.credentialId, version]))
        const values = new Map<string, string>()
        for (const credential of concrete) {
          const version = versionsByCredential.get(credential.id)
          if (!version) {
            await writeAudit(transaction, request, {
              skillId: skill.id,
              teamId: credential.teamId,
              outcome: 'denied',
              reasonCode: 'team_source_unavailable',
              bindingIds: [credential.id],
            })
            return { ok: false, statusCode: 409, error: 'A selected Team source is no longer available', reasonCode: 'team_source_unavailable' }
          }
          const value = decryptCredentialValue(
            version,
            {
              credentialId: credential.id,
              teamId: credential.teamId,
              envKey: credential.envKey,
              revision: credential.currentRevision,
            },
            keyring
          )
          values.set(credential.id, value)
        }
        const credentials: Array<{ key: string; value: string; teamId: string }> = servedSources.map((item) => ({
          key: item.key,
          value: values.get(item.credential.id) ?? '',
          teamId: item.credential.teamId,
        }))
        credentials.sort((left, right) => left.key.localeCompare(right.key, 'en'))
        // Name the main key when a value was served through an alias; never the value.
        const viaKeys = [...new Set(servedSources
          .filter((item) => item.key !== item.credential.envKey)
          .map((item) => item.credential.envKey))].sort()
        await writeAudit(transaction, request, {
          skillId: skill.id,
          teamId: teamIds.length === 1 ? teamIds[0] : null,
          outcome: 'success',
          bindingIds: concrete.map((credential) => credential.id),
          metadata: {
            keyCount: credentials.length,
            teamCount: teamIds.length,
            ...(viaKeys.length > 0 ? { viaKey: viaKeys.join(',') } : {}),
          },
        })
        return { ok: true, value: { dependencies: declared, credentials } }
      })
      if (!result.ok) return reply.code(result.statusCode).send({ error: result.error })
      return reply.send(result.value)
    } catch (error: unknown) {
      request.log.error(
        { err: error, action: 'runtime_env_resolve', skillId: body.data.skillId },
        'Runtime environment resolution failed'
      )
      return unavailable(reply)
    } finally {
      destroyCredentialKekKeyring(keyring)
    }
  })
}
