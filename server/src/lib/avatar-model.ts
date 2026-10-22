import { createHash, randomUUID } from 'node:crypto'
import { Prisma, type SkillAvatar } from '@prisma/client'
import { classicAvatarStyle } from './avatar-style-catalog.js'

export const avatarJobMirrorFields = [
  'input', 'inputFingerprint', 'promptVersion', 'prompt', 'status', 'requestId', 'submittedAt',
  'imageUrl', 'imageData', 'imageSha256', 'assetId', 'url', 'errorCode', 'attempts',
  'nextAttemptAt', 'leaseToken', 'leaseUntil', 'queuedAt', 'updatedAt',
] as const

export function avatarPromptHash(prompt: string | null): string | null {
  return prompt === null ? null : createHash('sha256').update(prompt).digest('hex')
}

/** Called after the legacy mutation, in its transaction. The anchor row serializes revisions. */
export async function mirrorSkillAvatar(tx: Prisma.TransactionClient, avatarId: string, newGeneration = false): Promise<string> {
  await tx.$queryRaw`SELECT id FROM skill_avatars WHERE id=${avatarId} FOR UPDATE`
  const avatar = await tx.skillAvatar.findUniqueOrThrow({ where: { id: avatarId } })
  const selection = await tx.avatarSelection.findUnique({ where: { ownerId_logicalSkillId: { ownerId: avatar.ownerId, logicalSkillId: avatarId } } })
  const oldJob = avatar.currentJobId ? await tx.avatarGenerationJob.findUniqueOrThrow({ where: { id: avatar.currentJobId } }) : null
  const changedSelection = selection !== null && (newGeneration || selection.source !== avatar.source
    || selection.customUrl !== avatar.customUrl || selection.customAssetId !== avatar.customAssetId
    || selection.customUpdatedAt?.getTime() !== avatar.customUpdatedAt?.getTime())
  const selectionRevision = (selection?.revision ?? 1) + (changedSelection ? 1 : 0)
  const fields = {
    input: avatar.input as Prisma.InputJsonValue, inputFingerprint: avatar.inputFingerprint,
    promptVersion: avatar.promptVersion, prompt: avatar.prompt, promptSha256: avatarPromptHash(avatar.prompt),
    status: avatar.status, requestId: avatar.requestId, submittedAt: avatar.submittedAt,
    imageUrl: avatar.imageUrl, imageData: avatar.imageData, imageSha256: avatar.imageSha256,
    assetId: avatar.assetId, url: avatar.url, errorCode: avatar.errorCode, attempts: avatar.attempts,
    nextAttemptAt: avatar.nextAttemptAt, leaseToken: avatar.leaseToken, leaseUntil: avatar.leaseUntil,
    queuedAt: avatar.queuedAt, updatedAt: avatar.updatedAt, selectionRevision,
  }
  let job = oldJob
  if (!job || newGeneration) {
    if (job && !['failed', 'cancelled', 'ready', 'superseded'].includes(job.status)) {
      throw new Error('AVATAR_ACTIVE_JOB_CONFLICT')
    }
    const revision = (job?.generationRevision ?? 0) + 1
    job = await tx.avatarGenerationJob.create({ data: {
      ...fields, id: oldJob ? randomUUID() : avatar.id, ownerId: avatar.ownerId, logicalSkillId: avatar.id,
      generationRevision: revision, styleId: 'classic', styleVersion: 1, path: 'meta',
      falModel: classicAvatarStyle.fal.meta.model, falParameters: classicAvatarStyle.fal.meta.parameters,
      idempotencyKey: `avatar:${avatar.id}:${revision}`, createdAt: oldJob ? new Date() : avatar.createdAt,
    } })
    // A compatibility pointer must not change legacy updatedAt or any DTO.
    await tx.$executeRaw`UPDATE skill_avatars SET "currentJobId"=${job.id} WHERE id=${avatar.id}`
  } else {
    job = await tx.avatarGenerationJob.update({ where: { id: job.id }, data: fields })
  }
  let variantId: string | null = null
  if (avatar.status === 'ready' && avatar.url) {
    const existing = await tx.avatarVariant.findUnique({ where: { jobId: job.id } })
    const result = {
      ownerId: avatar.ownerId, logicalSkillId: avatar.id, styleId: job.styleId, styleVersion: job.styleVersion,
      generationRevision: job.generationRevision, inputFingerprint: avatar.inputFingerprint, path: job.path!,
      promptVersion: avatar.promptVersion, prompt: avatar.prompt, promptSha256: job.promptSha256,
      assetId: avatar.assetId, url: avatar.url, imageSha256: avatar.imageSha256,
    }
    if (existing) {
      if (Object.entries(result).some(([key, value]) => existing[key as keyof typeof result] !== value)) throw new Error('AVATAR_VARIANT_CONFLICT')
      variantId = existing.id
    } else {
      variantId = (await tx.avatarVariant.create({ data: { ...result, jobId: job.id, createdAt: avatar.updatedAt } })).id
    }
  }
  if (avatar.status !== 'superseded') {
    const display = {
      source: avatar.source, variantId, currentJobId: job.id, revision: selectionRevision,
      customAssetId: avatar.customAssetId, customUrl: avatar.customUrl, customUpdatedAt: avatar.customUpdatedAt,
      updatedAt: avatar.updatedAt,
    }
    await tx.avatarSelection.upsert({
      where: { ownerId_logicalSkillId: { ownerId: avatar.ownerId, logicalSkillId: avatar.id } },
      create: { ...display, ownerId: avatar.ownerId, logicalSkillId: avatar.id, createdAt: avatar.createdAt }, update: display,
    })
  }
  return job.id
}

export function legacyAvatarDisplay(avatar: Pick<SkillAvatar, 'source' | 'customUrl' | 'status' | 'url'>): { avatarUrl: string | null; avatarStatus: string; avatarSource: string } {
  if (avatar.source === 'custom' && avatar.customUrl) return { avatarUrl: avatar.customUrl, avatarStatus: 'ready', avatarSource: 'custom' }
  return { avatarUrl: avatar.status === 'ready' ? avatar.url : null,
    avatarStatus: ['ready', 'failed', 'needs_review'].includes(avatar.status) ? avatar.status : 'pending', avatarSource: 'generated' }
}
