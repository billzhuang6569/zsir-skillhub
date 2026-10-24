import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { aiStatus } from '../lib/ai-settings.js'
import { getInstanceIdentity } from '../lib/instance-identity.js'
import { lockUserMutation } from '../lib/mutation-lock.js'
import { containsSensitiveContent } from '../lib/sensitive-content.js'
import {
  buildLocalAiInput, localAiInputHash, localAiBackoffMs, LOCAL_AI_CONFIG_VERSION,
  LOCAL_AI_LEASE_TTL_MS, LOCAL_AI_MAX_FAILURES, LOCAL_AI_FAILURE_CODES,
  recordAvatarDraftClient,
} from '../lib/local-ai-tasks.js'
import { acceptAvatarDraft, claimAvatarDraft, releaseAvatarDraft } from '../lib/local-avatar-drafts.js'
import { SkillProfileSchema } from './skills.js'

const ClaimBody = z.object({ types: z.array(z.enum(['analyzeSkill', 'draftAvatarPrompt'])).min(1).max(2)
  .refine(types => new Set(types).size === types.length) }).strict()
const ResultBody = z.object({
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  configVersion: z.string().min(1).max(100),
  profile: SkillProfileSchema.strict(),
}).strict()
const DraftResultBody = z.object({ inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  configVersion: z.string().min(1).max(100), prompt: z.string().trim().min(300).max(12_000) }).strict()
const FailureBody = z.object({ code: z.enum(LOCAL_AI_FAILURE_CODES) }).strict()
type LeaseParams = { leaseId: string }
type Outcome = { status: number; body?: object }
const failure = (status: number, code: string): Outcome => ({ status, body: { code } })

export const localAiRoutes: FastifyPluginAsync = async (fastify): Promise<void> => {
  if (config.SKILLHUB_PROFILE !== 'selfhost') return
  fastify.addHook('onSend', async (_request, reply, payload): Promise<typeof payload> => {
    reply.header('Cache-Control', 'no-store')
    return payload
  })
  fastify.addHook('onRequest', authMiddleware)
  const claims = new Map<string, { count: number; resetsAt: number }>()

  fastify.post('/leases', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const parsed = ClaimBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST' })
    const userId = request.user.id
    const tokenVersion = request.verifiedAuthToken?.ver
    if (tokenVersion === undefined) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    const rateNow = Date.now()
    for (const [id, window] of claims) if (window.resetsAt <= rateNow) claims.delete(id)
    const window = claims.get(userId) ?? { count: 0, resetsAt: rateNow + 60_000 }
    claims.set(userId, window)
    if (window.count >= 30) {
      return reply.code(429).header('Retry-After', Math.max(1, Math.ceil((window.resetsAt - rateNow) / 1000)))
        .send({ code: 'LOCAL_AI_RATE_LIMIT' })
    }
    window.count += 1
    const identity = getInstanceIdentity()
    if (!identity) return reply.code(503).send({ code: 'INSTANCE_IDENTITY_UNAVAILABLE' })
    const outcome = await db.$transaction(async (tx): Promise<Outcome> => {
      await lockUserMutation(tx, userId)
      const user = await tx.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } })
      if (user?.tokenVersion !== tokenVersion) return failure(401, 'UNAUTHORIZED')
      if (parsed.data.types.includes('draftAvatarPrompt')) recordAvatarDraftClient(userId)
      if (aiStatus().configured) return failure(409, 'INSTANCE_AI_CONFIGURED')
      if (parsed.data.types.includes('draftAvatarPrompt')) {
        const draft = await claimAvatarDraft(tx, userId, tokenVersion, identity.id)
        if (draft) return draft
      }
      if (!parsed.data.types.includes('analyzeSkill')) return { status: 204 }
      const now = new Date()
      let cursor: string | undefined
      // Bounded pages avoid loading every sourceContent into memory at once.
      for (;;) {
        const skills = await tx.skill.findMany({
          where: { authorId: userId, deletedAt: null, analysisStatus: 'unanalysed', sourceContent: { not: null },
            localAiLeases: { none: { type: 'analyzeSkill', expiresAt: { gt: now } } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: { id: true, name: true, description: true, sourceContent: true,
            localAiLeases: { where: { type: 'analyzeSkill' } } },
        })
        for (const skill of skills) {
          const input = buildLocalAiInput(skill)
          const inputHash = localAiInputHash(skill.id, input)
          const old = skill.localAiLeases[0]
          if (old?.state === 'failed' && old.inputHash === inputHash && old.failureCount >= LOCAL_AI_MAX_FAILURES) continue
          const leaseId = randomUUID()
          const expiresAt = new Date(now.getTime() + LOCAL_AI_LEASE_TTL_MS)
          // Native PG upsert, with eligibility repeated at the conflict boundary.
          // No Prisma read/create race or P2002 catch inside an aborted transaction.
          // Rotate the ID so a late failure/release cannot affect a newer attempt.
          const rows = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "local_ai_leases" ("id", "userId", "skillId", "type", "inputHash", "configVersion",
              "tokenVersion", "state", "failureCount", "expiresAt", "createdAt", "updatedAt")
            VALUES (${leaseId}, ${userId}, ${skill.id}, 'analyzeSkill', ${inputHash}, ${LOCAL_AI_CONFIG_VERSION},
              ${tokenVersion}, 'leased', 0, ${expiresAt}, ${now}, ${now})
            ON CONFLICT ("skillId", "type") DO UPDATE SET
              "id" = EXCLUDED."id", "userId" = EXCLUDED."userId", "inputHash" = EXCLUDED."inputHash",
              "configVersion" = EXCLUDED."configVersion", "tokenVersion" = EXCLUDED."tokenVersion",
              "state" = 'leased', "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = EXCLUDED."updatedAt",
              "failureCount" = CASE WHEN "local_ai_leases"."inputHash" = EXCLUDED."inputHash"
                THEN "local_ai_leases"."failureCount" ELSE 0 END
            WHERE "local_ai_leases"."userId" = EXCLUDED."userId"
              AND "local_ai_leases"."expiresAt" <= ${now}
              AND NOT ("local_ai_leases"."state" = 'failed'
                AND "local_ai_leases"."inputHash" = EXCLUDED."inputHash"
                AND "local_ai_leases"."failureCount" >= ${LOCAL_AI_MAX_FAILURES})
            RETURNING "id"
          `
          if (rows.length) return { status: 200, body: { leaseId, type: 'analyzeSkill', expiresAt,
            configVersion: LOCAL_AI_CONFIG_VERSION, inputHash, instanceId: identity.id, skillId: skill.id, input } }
        }
        if (skills.length < 100) return { status: 204 }
        cursor = skills[skills.length - 1].id
      }
    })
    return reply.code(outcome.status).send(outcome.body)
  })

  fastify.post('/leases/:leaseId/result', async (request: FastifyRequest<{ Params: LeaseParams; Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const parsed = z.union([ResultBody, DraftResultBody]).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_RESULT' })
    const { inputHash, configVersion } = parsed.data
    const profile = 'profile' in parsed.data ? parsed.data.profile : null
    // Scan strings individually: JSON escaping must not hide line-start secrets.
    if (profile && [profile.displayName, profile.description, profile.category, ...profile.labels, ...profile.triggerScenarios]
      .some(text => containsSensitiveContent(text) || /\bbearer\s+[A-Za-z0-9._~+\/=-]{20,}/i.test(text))) {
      return reply.code(400).send({ code: 'INVALID_RESULT' })
    }
    const tokenVersion = request.verifiedAuthToken?.ver
    if (tokenVersion === undefined) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    const userId = request.user.id
    const outcome = await db.$transaction(async (tx): Promise<Outcome> => {
      await lockUserMutation(tx, userId)
      const lease = await tx.localAiLease.findUnique({ where: { id: request.params.leaseId } })
      if (!lease || lease.userId !== userId) return failure(404, 'LEASE_NOT_FOUND')
      if (lease.type === 'draftAvatarPrompt' && lease.avatarJobId) {
        const job = await tx.avatarGenerationJob.findUnique({ where: { id: lease.avatarJobId } })
        if (!job || job.ownerId !== userId || job.status !== 'drafting' || job.prompt !== null
          || job.submittedAt !== null || job.requestId !== null) return failure(409, 'LEASE_STALE')
      }
      if (lease.state !== 'leased' || lease.expiresAt.getTime() <= Date.now()) return failure(410, 'LEASE_EXPIRED')
      const user = await tx.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } })
      if (lease.tokenVersion !== tokenVersion || user?.tokenVersion !== tokenVersion) return failure(409, 'LEASE_REVOKED')
      if (lease.type === 'draftAvatarPrompt') {
        if (!('prompt' in parsed.data)) return failure(409, 'LEASE_STALE')
        return acceptAvatarDraft(tx, lease, parsed.data)
      }
      if (!profile || !lease.skillId) return failure(409, 'LEASE_STALE')
      const skill = await tx.skill.findUnique({ where: { id: lease.skillId } })
      if (lease.type !== 'analyzeSkill' || configVersion !== LOCAL_AI_CONFIG_VERSION
        || lease.configVersion !== configVersion || lease.inputHash !== inputHash
        || !skill || skill.authorId !== userId || skill.deletedAt || skill.analysisStatus !== 'unanalysed'
        || skill.sourceContent === null || localAiInputHash(skill.id, buildLocalAiInput(skill)) !== inputHash) {
        return failure(409, 'LEASE_STALE')
      }
      const changed = await tx.skill.updateMany({
        where: { id: skill.id, authorId: userId, deletedAt: null, analysisStatus: 'unanalysed', updatedAt: skill.updatedAt },
        data: { ...(skill.profileManuallyEdited ? {} : profile),
          labels: skill.labelsManuallyEdited ? skill.labels as string[] : profile.labels, analysisStatus: 'completed' },
      })
      if (!changed.count) return failure(409, 'LEASE_STALE')
      await tx.localAiLease.delete({ where: { id: lease.id } })
      return { status: 200, body: { skillId: skill.id, analysisStatus: 'completed' } }
    })
    return reply.code(outcome.status).send(outcome.body)
  })

  fastify.post('/leases/:leaseId/failure', async (request: FastifyRequest<{ Params: LeaseParams; Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    if (!FailureBody.safeParse(request.body).success) return reply.code(400).send({ code: 'INVALID_REQUEST' })
    const outcome = await db.$transaction(async (tx): Promise<Outcome> => {
      await lockUserMutation(tx, request.user.id)
      const lease = await tx.localAiLease.findUnique({ where: { id: request.params.leaseId } })
      if (!lease || lease.userId !== request.user.id) return failure(404, 'LEASE_NOT_FOUND')
      if (lease.state !== 'leased') return failure(410, 'LEASE_EXPIRED')
      if (lease.type === 'draftAvatarPrompt') {
        await releaseAvatarDraft(tx, lease)
        return { status: 204 }
      }
      if (lease.type !== 'analyzeSkill') return failure(409, 'LEASE_STALE')
      const failureCount = lease.failureCount + 1
      await tx.localAiLease.update({ where: { id: lease.id }, data: {
        state: 'failed', failureCount, expiresAt: new Date(Date.now() + localAiBackoffMs(failureCount)),
      } })
      return { status: 204 }
    })
    return reply.code(outcome.status).send(outcome.body)
  })

  fastify.delete('/leases/:leaseId', async (request: FastifyRequest<{ Params: LeaseParams }>, reply: FastifyReply): Promise<FastifyReply> => {
    await db.$transaction(async (tx): Promise<void> => {
      await lockUserMutation(tx, request.user.id)
      const lease = await tx.localAiLease.findUnique({ where: { id: request.params.leaseId } })
      if (lease?.userId === request.user.id && lease.state === 'leased' && lease.type === 'draftAvatarPrompt') {
        await releaseAvatarDraft(tx, lease)
        return
      }
      await tx.localAiLease.deleteMany({ where: { id: request.params.leaseId, userId: request.user.id, state: 'leased' } })
    })
    return reply.code(204).send()
  })
  fastify.delete('/leases', async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    await db.$transaction(async (tx): Promise<void> => {
      await lockUserMutation(tx, request.user.id)
      const drafts = await tx.localAiLease.findMany({ where: { userId: request.user.id, state: 'leased', type: 'draftAvatarPrompt' } })
      for (const lease of drafts) await releaseAvatarDraft(tx, lease)
      await tx.localAiLease.deleteMany({ where: { userId: request.user.id, state: 'leased' } })
    })
    return reply.code(204).send()
  })
}
