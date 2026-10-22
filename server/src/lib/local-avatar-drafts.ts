import { randomUUID } from 'node:crypto'
import type { LocalAiLease, Prisma } from '@prisma/client'
import { getAvatarStyle } from './avatar-styles.js'
import { AvatarInput } from './skill-avatar-input.js'
import { avatarPromptHash } from './avatar-model.js'
import { mirrorAvatarJob } from './avatar-jobs.js'
import { avatarGenerationEnabled } from './avatar-generation.js'
import { variantsMode } from './avatar-selection.js'
import { AVATAR_DRAFT_CONFIG_VERSION, LOCAL_AI_LEASE_TTL_MS, avatarDraftInput, avatarDraftInputHash,
  avatarDraftWithCanvas, validAvatarDraft } from './local-ai-tasks.js'

type Tx = Prisma.TransactionClient
export type LocalAiOutcome = { status: number; body?: object }
const stale = (): LocalAiOutcome => ({ status: 409, body: { code: 'LEASE_STALE' } })

/** Caller holds lockUserMutation and has revalidated the user's token version. */
export async function claimAvatarDraft(tx: Tx, userId: string, tokenVersion: number, instanceId: string): Promise<LocalAiOutcome | null> {
  if (!variantsMode() || !avatarGenerationEnabled()) return null
  const now = new Date()
  let cursor: string | undefined
  for (;;) {
    const jobs = await tx.avatarGenerationJob.findMany({ where: { ownerId: userId, status: 'drafting', prompt: null,
      submittedAt: null, requestId: null,
      localAiLeases: { none: { type: 'draftAvatarPrompt', state: 'leased', expiresAt: { gt: now } } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) })
    for (const job of jobs) {
      const style = await getAvatarStyle(job.styleId, job.styleVersion, tx)
      const parsed = AvatarInput.safeParse(job.input)
      const input = style && parsed.success ? avatarDraftInput(parsed.data, style) : null
      if (!input || !style) {
        // Oversized briefs are unavailable for local inference; wake the direct path.
        await tx.avatarGenerationJob.updateMany({ where: { id: job.id, status: 'drafting', prompt: null,
          submittedAt: null, requestId: null }, data: { nextAttemptAt: now } })
        await mirrorAvatarJob(tx, job.logicalSkillId)
        continue
      }
      const inputHash = avatarDraftInputHash(job.id, style, input)
      const leaseId = randomUUID(), expiresAt = new Date(now.getTime() + LOCAL_AI_LEASE_TTL_MS)
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "local_ai_leases" ("id", "userId", "avatarJobId", "type", "inputHash", "configVersion",
          "tokenVersion", "state", "failureCount", "expiresAt", "createdAt", "updatedAt")
        VALUES (${leaseId}, ${userId}, ${job.id}, 'draftAvatarPrompt', ${inputHash}, ${AVATAR_DRAFT_CONFIG_VERSION},
          ${tokenVersion}, 'leased', 0, ${expiresAt}, ${now}, ${now})
        ON CONFLICT ("avatarJobId", "type") DO UPDATE SET
          "id" = EXCLUDED."id", "userId" = EXCLUDED."userId", "inputHash" = EXCLUDED."inputHash",
          "configVersion" = EXCLUDED."configVersion", "tokenVersion" = EXCLUDED."tokenVersion",
          "state" = 'leased', "failureCount" = 0, "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = EXCLUDED."updatedAt"
        WHERE "local_ai_leases"."userId" = EXCLUDED."userId" AND "local_ai_leases"."expiresAt" <= ${now}
        RETURNING "id"
      `
      if (rows.length) return { status: 200, body: { leaseId, type: 'draftAvatarPrompt', expiresAt,
        configVersion: AVATAR_DRAFT_CONFIG_VERSION, inputHash, instanceId, avatarJobId: job.id, input } }
    }
    if (jobs.length < 100) return null
    cursor = jobs[jobs.length - 1].id
  }
}

/** Lease ownership, expiry and token version are checked by the route under the same lock. */
export async function acceptAvatarDraft(tx: Tx, lease: LocalAiLease,
  result: { inputHash: string; configVersion: string; prompt: string }): Promise<LocalAiOutcome> {
  if (!lease.avatarJobId || lease.type !== 'draftAvatarPrompt' || result.configVersion !== AVATAR_DRAFT_CONFIG_VERSION
    || lease.configVersion !== result.configVersion || lease.inputHash !== result.inputHash) return stale()
  const job = await tx.avatarGenerationJob.findUnique({ where: { id: lease.avatarJobId } })
  if (!job || job.ownerId !== lease.userId || job.status !== 'drafting' || job.prompt !== null
    || job.submittedAt !== null || job.requestId !== null) return stale()
  const style = await getAvatarStyle(job.styleId, job.styleVersion, tx)
  const parsed = AvatarInput.safeParse(job.input)
  const input = style && parsed.success ? avatarDraftInput(parsed.data, style) : null
  if (!style || !input || avatarDraftInputHash(job.id, style, input) !== result.inputHash) return stale()
  const draft = result.prompt.trim()
  if (!validAvatarDraft(draft, style)) return { status: 400, body: { code: 'INVALID_RESULT' } }
  const prompt = avatarDraftWithCanvas(draft, style)
  const changed = await tx.avatarGenerationJob.updateMany({ where: { id: job.id, ownerId: lease.userId,
    status: 'drafting', prompt: null, submittedAt: null, requestId: null },
  data: { prompt, promptSha256: avatarPromptHash(prompt), path: 'meta', promptSource: 'local', status: 'queued',
    nextAttemptAt: new Date(), draftDeadline: null, leaseToken: null, leaseUntil: null } })
  if (!changed.count) return stale()
  await tx.localAiLease.delete({ where: { id: lease.id } })
  await mirrorAvatarJob(tx, job.logicalSkillId)
  return { status: 200, body: { avatarJobId: job.id, accepted: true } }
}

/** Failure/release wakes the worker without consuming the analyzeSkill retry budget. */
export async function releaseAvatarDraft(tx: Tx, lease: LocalAiLease): Promise<void> {
  if (!lease.avatarJobId) return
  const job = await tx.avatarGenerationJob.findUnique({ where: { id: lease.avatarJobId } })
  if (job && job.ownerId === lease.userId) {
    await tx.avatarGenerationJob.updateMany({ where: { id: job.id, status: 'drafting', prompt: null,
      submittedAt: null, requestId: null }, data: { nextAttemptAt: new Date() } })
    await mirrorAvatarJob(tx, job.logicalSkillId)
  }
  await tx.localAiLease.deleteMany({ where: { id: lease.id, userId: lease.userId, state: 'leased' } })
}
