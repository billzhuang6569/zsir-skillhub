import { randomUUID } from 'node:crypto'
import { Prisma, type AvatarGenerationJob, type SkillAvatar } from '@prisma/client'
import { db } from '../db.js'
import { avatarGenerationEnabled } from './avatar-generation.js'
import { config } from '../config.js'
import { lockUserMutation } from './mutation-lock.js'
import { avatarPromptHash } from './avatar-model.js'
import { latestAvatarStyle } from './avatar-styles.js'
import type { AvatarStyle } from './avatar-style-catalog.js'
import { fillEmptyListingAvatar, selectionDisplaySelect, type SelectionDisplay } from './avatar-selection.js'
import { AvatarError, retryTarget, secondsUntilNextUtcMidnight, utcDay, type AvatarAttemptKind } from './skill-avatars.js'

type Tx = Prisma.TransactionClient
export type AvatarTask = SkillAvatar & { selection?: SelectionDisplay | null; job?: AvatarGenerationJob }
export const ACTIVE_AVATAR_JOBS = ['queued', 'drafting', 'prompting', 'submitting', 'awaiting', 'transferring', 'needs_review']

export async function resolveAccountAvatarStyle(tx: Tx, ownerId: string): Promise<{
  accountStyleId: string | null; instanceStyleId: string; style: AvatarStyle;
}> {
  const user = await tx.user.findUniqueOrThrow({ where: { id: ownerId }, select: { avatarStyleId: true } })
  const setting = await tx.serverSetting.findUnique({ where: { key: 'avatar.style' } })
  const value = setting?.value
  const instanceStyleId = value && typeof value === 'object' && !Array.isArray(value) && typeof value.styleId === 'string' ? value.styleId : 'classic'
  const accountStyleId = config.SKILLHUB_PROFILE === 'selfhost' ? null : user.avatarStyleId
  const style = await latestAvatarStyle(accountStyleId ?? instanceStyleId, tx)
  if (!style) throw new AvatarError(400, '头像风格不可用', 'AVATAR_STYLE_UNAVAILABLE')
  return { accountStyleId, instanceStyleId, style }
}

export async function readAvatarTask(tx: Tx, id: string): Promise<AvatarTask> {
  const anchor = await tx.skillAvatar.findUniqueOrThrow({ where: { id }, include: {
    currentJob: true, selection: { select: selectionDisplaySelect },
  } })
  if (!anchor.currentJob) throw new Error('AVATAR_CURRENT_JOB_MISSING')
  const { currentJob: job, ...identity } = anchor
  return { ...identity, ...job, id: anchor.id, currentJobId: job.id, source: anchor.selection?.source ?? 'generated', customUrl: anchor.selection?.customUrl ?? null, job }
}

/** New-model evidence projected back for recovery; the mirror is never a second queue. */
export async function mirrorAvatarJob(tx: Tx, logicalSkillId: string): Promise<void> {
  const anchor = await tx.skillAvatar.findUniqueOrThrow({ where: { id: logicalSkillId }, include: { currentJob: true, selection: true } })
  const job = anchor.currentJob
  const selection = anchor.selection
  if (!job || !selection) throw new Error('AVATAR_MODEL_INCOMPLETE')
  await tx.skillAvatar.update({ where: { id: anchor.id }, data: {
    input: job.input as Prisma.InputJsonValue, inputFingerprint: job.inputFingerprint, promptVersion: job.promptVersion,
    prompt: job.prompt, status: job.status, requestId: job.requestId, submittedAt: job.submittedAt,
    imageUrl: job.imageUrl, imageData: job.imageData, imageSha256: job.imageSha256, assetId: job.assetId, url: job.url,
    errorCode: job.errorCode, attempts: job.attempts, nextAttemptAt: job.nextAttemptAt,
    leaseToken: job.leaseToken, leaseUntil: job.leaseUntil, queuedAt: job.queuedAt, updatedAt: job.updatedAt,
    source: selection.source, customAssetId: selection.customAssetId, customUrl: selection.customUrl, customUpdatedAt: selection.customUpdatedAt,
  } })
}

/** Owner lock held. A paid retry gets a new row; submittedAt is never reset. */
export async function createAvatarJob(tx: Tx, anchor: SkillAvatar, kind: AvatarAttemptKind | null, targetStyle?: AvatarStyle): Promise<void> {
  const key = { ownerId: anchor.ownerId, logicalSkillId: anchor.id }
  const { style } = targetStyle ? { style: targetStyle } : await resolveAccountAvatarStyle(tx, anchor.ownerId)
  const active = await tx.avatarGenerationJob.count({ where: { ...key, styleId: style.styleId, status: { in: ACTIVE_AVATAR_JOBS } } })
  if (active) throw new AvatarError(409, '已有头像任务等待完成或恢复', 'AVATAR_ACTIVE_JOB_CONFLICT')
  const selection = await tx.avatarSelection.findUnique({ where: { ownerId_logicalSkillId: key } })
  const previous = await tx.avatarGenerationJob.findFirst({ where: key, orderBy: { generationRevision: 'desc' } })
  const generationRevision = (previous?.generationRevision ?? 0) + 1
  const revision = (selection?.revision ?? 0) + 1
  let now = new Date()
  if (kind) {
    if (!avatarGenerationEnabled()) throw new AvatarError(503, '头像生成暂未开启', 'AVATAR_GENERATION_DISABLED')
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(71382654)::text`
    now = new Date() // UTC day after waiting for the shared quota lock.
    const used = await tx.skillAvatarGenerationAttempt.count({ where: { day: utcDay(now), releasedAt: null } })
    if (used >= config.SKILL_AVATAR_DAILY_LIMIT) throw new AvatarError(429, '头像生成额度已达上限，请稍后重试', 'AVATAR_DAILY_QUOTA', secondsUntilNextUtcMidnight(now))
  }
  const job = await tx.avatarGenerationJob.create({ data: {
    ...key, generationRevision, selectionRevision: revision, styleId: style.styleId, styleVersion: style.styleVersion,
    input: (previous?.input ?? anchor.input) as Prisma.InputJsonValue, inputFingerprint: previous?.inputFingerprint ?? anchor.inputFingerprint,
    promptVersion: style.legacy?.promptVersion ?? `${style.styleId}:${style.styleVersion}`,
    falModel: style.fal.meta.model, falParameters: style.fal.meta.parameters,
    idempotencyKey: `avatar:${anchor.id}:${generationRevision}`, status: kind ? 'queued' : 'cancelled', queuedAt: kind ? now : null,
  } })
  await tx.avatarSelection.upsert({ where: { ownerId_logicalSkillId: key }, create: {
    ...key, currentJobId: job.id, revision, source: kind ? 'generated' : 'custom',
    customAssetId: anchor.customAssetId, customUrl: anchor.customUrl, customUpdatedAt: anchor.customUpdatedAt,
  }, update: { currentJobId: job.id, revision, source: 'generated' } })
  await tx.skillAvatar.update({ where: { id: anchor.id }, data: { currentJobId: job.id } })
  if (kind) await tx.skillAvatarGenerationAttempt.create({ data: { avatarId: anchor.id, jobId: job.id, day: utcDay(now), kind, createdAt: now } })
  await mirrorAvatarJob(tx, anchor.id)
}

/** Owner lock held; a local drafting lease also counts as a lease. Never refund paid/unknown work. */
export async function cancelUnsubmittedAvatarJobs(tx: Tx, where: Prisma.AvatarGenerationJobWhereInput): Promise<number> {
  const jobs = await tx.avatarGenerationJob.findMany({ where: { AND: [where, {
    status: { in: ['queued', 'drafting'] }, submittedAt: null, requestId: null, leaseToken: null, leaseUntil: null,
    localAiLeases: { none: { state: 'leased', expiresAt: { gt: new Date() } } },
  }] }, select: { id: true } })
  if (!jobs.length) return 0
  const ids = jobs.map(job => job.id)
  await tx.avatarGenerationJob.updateMany({ where: { id: { in: ids } }, data: { status: 'cancelled' } })
  await tx.skillAvatarGenerationAttempt.updateMany({ where: { jobId: { in: ids }, releasedAt: null }, data: { releasedAt: new Date() } })
  return ids.length
}

export async function selectCustomAvatar(tx: Tx, anchor: SkillAvatar, custom: { customAssetId: string; customUrl: string; customUpdatedAt: Date }): Promise<AvatarTask> {
  const selection = await tx.avatarSelection.update({ where: { ownerId_logicalSkillId: { ownerId: anchor.ownerId, logicalSkillId: anchor.id } },
    data: { ...custom, source: 'custom', revision: { increment: 1 } } })
  if (selection.currentJobId) {
    await cancelUnsubmittedAvatarJobs(tx, { id: selection.currentJobId })
  }
  await mirrorAvatarJob(tx, anchor.id)
  await fillEmptyListingAvatar(tx, anchor.ownerId, anchor.skillId)
  return readAvatarTask(tx, anchor.id)
}

export async function restoreAvatarSelection(tx: Tx, anchor: SkillAvatar): Promise<AvatarTask> {
  const key = { ownerId: anchor.ownerId, logicalSkillId: anchor.id }
  const selection = await tx.avatarSelection.findUniqueOrThrow({ where: { ownerId_logicalSkillId: key }, include: { currentJob: { include: { variant: true } } } })
  if (selection.source !== 'custom') return readAvatarTask(tx, anchor.id)
  const job = selection.currentJob
  // A quota-deferred style switch deliberately detaches the old display job.
  if (!job && selection.variantId) {
    await tx.avatarSelection.update({ where: { ownerId_logicalSkillId: key }, data: { source: 'generated', revision: { increment: 1 } } })
    await mirrorAvatarJob(tx, anchor.id)
  } else if (!job || job.status === 'cancelled') await createAvatarJob(tx, anchor, 'restore')
  else {
    const revision = selection.revision + 1
    await tx.avatarSelection.update({ where: { ownerId_logicalSkillId: key }, data: {
      source: 'generated', revision, ...(job.variant ? { variantId: job.variant.id } : {}),
    } })
    await tx.avatarGenerationJob.update({ where: { id: job.id }, data: { selectionRevision: revision } })
    await mirrorAvatarJob(tx, anchor.id)
  }
  await fillEmptyListingAvatar(tx, anchor.ownerId, anchor.skillId)
  return readAvatarTask(tx, anchor.id)
}

export async function retryAvatarJob(ownerId: string, id: string, realJob = false): Promise<{ transitioned: boolean; avatar: AvatarTask }> {
  return db.$transaction(async tx => {
    await lockUserMutation(tx, ownerId)
    // API passes an anchor ID; ops passes a real Job ID (including legacy UUIDs).
    const anchor = realJob ? null : await tx.skillAvatar.findUnique({ where: { id } })
    const job = anchor?.currentJobId
      ? await tx.avatarGenerationJob.findUnique({ where: { id: anchor.currentJobId } })
      : await tx.avatarGenerationJob.findUnique({ where: { id } })
    if (!job || job.ownerId !== ownerId) throw new AvatarError(404, '头像不存在')
    const identity = anchor ?? await tx.skillAvatar.findUniqueOrThrow({ where: { id: job.logicalSkillId } })
    const selected = await tx.avatarSelection.findUniqueOrThrow({ where: { ownerId_logicalSkillId: { ownerId, logicalSkillId: identity.id } } })
    if (selected.source === 'custom') throw new AvatarError(409, '当前使用自定义头像', 'AVATAR_CUSTOM_ACTIVE')
    const target = retryTarget(job)
    if (!target) return { transitioned: false, avatar: await readAvatarTask(tx, identity.id) }
    const active = await tx.avatarGenerationJob.count({ where: { ownerId, logicalSkillId: identity.id, styleId: job.styleId, id: { not: job.id },
      status: { in: ['queued', 'drafting', 'prompting', 'submitting', 'awaiting', 'transferring', 'needs_review'] } } })
    if (active) return { transitioned: false, avatar: await readAvatarTask(tx, identity.id) }
    if (target === 'queued') {
      if (identity.currentJobId !== job.id) return { transitioned: false, avatar: await readAvatarTask(tx, identity.id) }
      await createAvatarJob(tx, identity, 'retry')
    } else {
      await tx.avatarGenerationJob.update({ where: { id: job.id }, data: { status: target, attempts: 0, errorCode: null, nextAttemptAt: new Date() } })
      await mirrorAvatarJob(tx, identity.id)
    }
    return { transitioned: true, avatar: await readAvatarTask(tx, identity.id) }
  })
}

export async function persistAvatarJob(task: AvatarTask, data: Prisma.AvatarGenerationJobUpdateManyMutationInput): Promise<boolean> {
  const id = task.job?.id ?? task.id
  return db.$transaction(async tx => {
    await lockUserMutation(tx, task.ownerId)
    const drafting = task.status === 'drafting'
    // Same owner lock as local claim/result: checking the lease and consuming the
    // submission right cannot interleave with a new local lease.
    if (drafting && data.status === 'submitting') {
      const lease = await tx.localAiLease.findFirst({ where: { avatarJobId: id, type: 'draftAvatarPrompt',
        state: 'leased', expiresAt: { gt: new Date() } } })
      if (lease) {
        const deferred = await tx.avatarGenerationJob.updateMany({ where: { id, leaseToken: task.leaseToken,
          status: 'drafting', prompt: null, submittedAt: null, requestId: null },
        data: { nextAttemptAt: lease.expiresAt, leaseToken: null, leaseUntil: null } })
        if (deferred.count) await mirrorAvatarJob(tx, task.job?.logicalSkillId ?? task.id)
        return false
      }
    }
    const updated = await tx.avatarGenerationJob.updateMany({ where: { id, leaseToken: task.leaseToken,
      ...(data.status === 'submitting' && drafting
        ? { status: 'drafting', prompt: null, submittedAt: null, requestId: null }
        : data.status === 'submitting' || data.status === 'prompting' || data.status === 'drafting'
          ? { status: { in: ['queued', 'prompting'] }, submittedAt: null, requestId: null,
            ...(data.status === 'drafting' ? { prompt: null, draftDeadline: null } : {}) } : {}),
    }, data: { ...data, ...(typeof data.prompt === 'string' ? { promptSha256: avatarPromptHash(data.prompt) } : {}) } })
    if (updated.count !== 1) return false
    const job = await tx.avatarGenerationJob.findUniqueOrThrow({ where: { id } })
    if (job.status === 'ready') {
      if (!job.url || !job.assetId || !job.path) throw new Error('AVATAR_READY_INCOMPLETE')
      const result = {
        ownerId: job.ownerId, logicalSkillId: job.logicalSkillId, styleId: job.styleId, styleVersion: job.styleVersion,
        generationRevision: job.generationRevision, inputFingerprint: job.inputFingerprint, path: job.path,
        promptVersion: job.promptVersion, prompt: job.prompt, promptSha256: job.promptSha256,
        assetId: job.assetId, url: job.url, imageSha256: job.imageSha256, jobId: id,
      }
      const existing = await tx.avatarVariant.findUnique({ where: { jobId: id } })
      if (existing && Object.entries(result).some(([key, value]) => existing[key as keyof typeof result] !== value)) throw new Error('AVATAR_VARIANT_CONFLICT')
      const variant = existing ?? await tx.avatarVariant.create({ data: result })
      await tx.avatarSelection.updateMany({ where: { ownerId: job.ownerId, logicalSkillId: job.logicalSkillId,
        currentJobId: id, revision: job.selectionRevision, source: 'generated' }, data: { variantId: variant.id } })
    }
    await mirrorAvatarJob(tx, job.logicalSkillId)
    if (job.status === 'ready') {
      const identity = await tx.skillAvatar.findUniqueOrThrow({ where: { id: job.logicalSkillId }, select: { skillId: true } })
      await fillEmptyListingAvatar(tx, job.ownerId, identity.skillId)
    }
    return true
  })
}

export function availableJobs(statuses: readonly string[], now: Date): Prisma.AvatarGenerationJobWhereInput {
  return { status: { in: [...statuses] }, nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }
}

export async function claimAvatarJob(statuses: readonly string[], now: Date): Promise<AvatarTask | null> {
  const available = availableJobs(statuses, now)
  const due = await db.avatarGenerationJob.findMany({ where: available, select: { id: true, ownerId: true },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: 2_000 })
  if (!due.length) return null
  const heads = new Map<string, { id: string; rank: number }>()
  due.forEach((row, rank) => { if (!heads.has(row.ownerId)) heads.set(row.ownerId, { id: row.id, rank }) })
  const leased = await db.avatarGenerationJob.groupBy({ by: ['ownerId'], where: { ownerId: { in: [...heads.keys()] }, leaseUntil: { gte: now } }, _count: { _all: true } })
  const busy = new Map(leased.map(row => [row.ownerId, row._count._all]))
  const order = [...heads].sort(([a, left], [b, right]) => (busy.get(a) ?? 0) - (busy.get(b) ?? 0) || left.rank - right.rank)
  for (const id of new Set([...order.map(([, head]) => head.id), ...due.map(row => row.id)])) {
    const ownerId = due.find(row => row.id === id)!.ownerId
    const result = await db.$transaction(async tx => {
      await lockUserMutation(tx, ownerId)
      const leaseToken = randomUUID()
      const claimed = await tx.avatarGenerationJob.updateMany({ where: { ...available, id }, data: { leaseToken, leaseUntil: new Date(now.getTime() + 180_000) } })
      if (claimed.count !== 1) return null
      const job = await tx.avatarGenerationJob.findUniqueOrThrow({ where: { id } })
      await mirrorAvatarJob(tx, job.logicalSkillId)
      const anchor = await readAvatarTask(tx, job.logicalSkillId)
      return { ...anchor, ...job, id: job.id, job }
    })
    if (result) return result
  }
  return null
}
