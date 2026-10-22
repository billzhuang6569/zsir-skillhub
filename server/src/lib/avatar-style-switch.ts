import type { Prisma } from '@prisma/client'
import { config } from '../config.js'
import { db } from '../db.js'
import { ACTIVE_AVATAR_JOBS, cancelUnsubmittedAvatarJobs, createAvatarJob, mirrorAvatarJob, resolveAccountAvatarStyle } from './avatar-jobs.js'
import type { AvatarStyle } from './avatar-style-catalog.js'
import { latestAvatarStyle } from './avatar-styles.js'
import { falPriceEstimate } from './fal-pricing.js'
import { lockUserMutation } from './mutation-lock.js'
import { writeServerSetting } from './server-settings.js'
import { AvatarError, avatarQuotaToday } from './skill-avatars.js'

export const avatarStyleScope = (): 'instance' | 'account' => config.SKILLHUB_PROFILE === 'selfhost' ? 'instance' : 'account'

// Cloud anchors must still belong to this owner; local-only anchors already carry owner identity.
function ownedAnchors(ownerId: string): Prisma.SkillAvatarWhereInput {
  return { ownerId, status: { not: 'superseded' }, selection: { isNot: null },
    OR: [{ skillId: null }, { skill: { is: { authorId: ownerId, deletedAt: null } } }] }
}

async function owners(actorId: string): Promise<string[]> {
  if (avatarStyleScope() === 'account') return [actorId]
  const rows = await db.skillAvatar.findMany({ where: { status: { not: 'superseded' }, selection: { isNot: null } },
    distinct: ['ownerId'], select: { ownerId: true }, orderBy: { ownerId: 'asc' } })
  return rows.map(row => row.ownerId)
}

async function targetStyle(actorId: string, styleId: string | null, tx: Prisma.TransactionClient = db): Promise<AvatarStyle> {
  if (avatarStyleScope() === 'instance' && styleId === null) throw new AvatarError(400, '实例风格不能为空', 'INVALID_REQUEST')
  const id = styleId ?? (await resolveAccountAvatarStyle(tx, actorId)).instanceStyleId
  const style = await latestAvatarStyle(id, tx)
  if (!style) throw new AvatarError(400, '头像风格不可用', 'AVATAR_STYLE_UNAVAILABLE')
  return style
}

export async function previewAvatarStyle(actorId: string, styleId: string | null): Promise<object> {
  const current = await resolveAccountAvatarStyle(db, actorId)
  const target = await targetStyle(actorId, styleId)
  let total = 0, reusable = 0, needsGeneration = 0, customSkipped = 0, inFlight = 0
  for (const ownerId of await owners(actorId)) {
    const anchors = await db.skillAvatar.findMany({ where: ownedAnchors(ownerId), select: {
      selection: { select: { source: true } },
      variants: { where: { styleId: target.styleId }, take: 1, select: { id: true } },
      jobs: { where: { styleId: target.styleId, status: { in: ACTIVE_AVATAR_JOBS } }, take: 1, select: { id: true } },
    } })
    for (const anchor of anchors) {
      total += 1
      if (anchor.selection?.source === 'custom') customSkipped += 1
      else if (anchor.variants.length) reusable += 1
      else if (anchor.jobs.length) inFlight += 1
      else needsGeneration += 1
    }
  }
  const { limit, used, remaining } = await avatarQuotaToday()
  return { scope: avatarStyleScope(), currentStyleId: current.style.styleId, targetStyleId: target.styleId,
    targetStyleVersion: target.styleVersion, total, reusable, needsGeneration, customSkipped, inFlight,
    ...falPriceEstimate(target.fal.meta.model, needsGeneration), quota: { limit, used, remaining }, coverable: Math.min(needsGeneration, remaining) }
}

type ApplyCounts = { reused: number; queued: number; skippedCustom: number; deferredByQuota: number; cancelledUnsubmitted: number }
const emptyCounts = (): ApplyCounts => ({ reused: 0, queued: 0, skippedCustom: 0, deferredByQuota: 0, cancelledUnsubmitted: 0 })
export type ApplyStyleInput = { styleId: string | null; mode: 'newOnly' | 'applyExisting'; includeCustom?: boolean }

/** Owner lock held. Every selection intent and its ledger mutations commit together. */
async function applyOwner(tx: Prisma.TransactionClient, ownerId: string, style: AvatarStyle, includeCustom: boolean): Promise<ApplyCounts> {
  const result = emptyCounts()
  const anchors = await tx.skillAvatar.findMany({ where: ownedAnchors(ownerId), include: { selection: true }, orderBy: { id: 'asc' } })
  for (const anchor of anchors) {
    const selection = anchor.selection!
    if (selection.source === 'custom' && !includeCustom) { result.skippedCustom += 1; continue }
    const key = { ownerId, logicalSkillId: anchor.id }
    result.cancelledUnsubmitted += await cancelUnsubmittedAvatarJobs(tx, { ...key, styleId: { not: style.styleId } })
    const variant = await tx.avatarVariant.findFirst({ where: { ...key, styleId: style.styleId },
      orderBy: [{ createdAt: 'desc' }, { generationRevision: 'desc' }] })
    const active = variant ? null : await tx.avatarGenerationJob.findFirst({ where: { ...key, styleId: style.styleId, status: { in: ACTIVE_AVATAR_JOBS } } })
    const fallback = variant ?? await tx.avatarVariant.findFirst({ where: key, orderBy: [{ createdAt: 'desc' }, { generationRevision: 'desc' }] })
    const revision = selection.revision + 1
    // Invalidate old work even when quota prevents a new job. Preserve the previous image as fallback.
    await tx.avatarSelection.update({ where: { ownerId_logicalSkillId: key }, data: {
      source: 'generated', revision, currentJobId: variant?.jobId ?? active?.id ?? null, variantId: fallback?.id ?? null,
    } })
    if (variant) {
      result.reused += 1
      await tx.skillAvatar.update({ where: { id: anchor.id }, data: { currentJobId: variant.jobId } })
    }
    else if (active) {
      await tx.avatarGenerationJob.update({ where: { id: active.id }, data: { selectionRevision: revision } })
      await tx.skillAvatar.update({ where: { id: anchor.id }, data: { currentJobId: active.id } })
    } else {
      try { await createAvatarJob(tx, anchor, 'create', style); result.queued += 1 }
      catch (error: unknown) {
        // This check throws before any job/ledger write; other failures roll back the owner.
        if (!(error instanceof AvatarError) || error.code !== 'AVATAR_DAILY_QUOTA') throw error
        result.deferredByQuota += 1
      }
    }
    await mirrorAvatarJob(tx, anchor.id)
  }
  return result
}

type ApplyResult = ApplyCounts & { styleId: string; styleVersion: number }
let instanceApply: Promise<unknown> = Promise.resolve()

export async function applyAvatarStyle(actorId: string, input: ApplyStyleInput): Promise<ApplyResult> {
  if (avatarStyleScope() === 'account') return applyStyle(actorId, input)
  // Settings/cache currently support one Server process. Keep competing instance
  // switches ordered across owner transactions, including newOnly requests.
  const next = instanceApply.then(() => applyStyle(actorId, input))
  instanceApply = next.catch(() => {})
  return next
}

async function applyStyle(actorId: string, input: ApplyStyleInput): Promise<ApplyResult> {
  const style = await targetStyle(actorId, input.styleId)
  const result = { styleId: style.styleId, styleVersion: style.styleVersion, ...emptyCounts() }
  if (avatarStyleScope() === 'account') {
    return db.$transaction(async tx => {
      await lockUserMutation(tx, actorId)
      await tx.user.update({ where: { id: actorId }, data: { avatarStyleId: input.styleId } })
      return input.mode === 'newOnly' ? result : { ...result, ...await applyOwner(tx, actorId, style, input.includeCustom ?? false) }
    }, { timeout: 30_000 })
  }
  // Commit the instance default first so imports immediately use it. Each owner is an independent transaction.
  await writeServerSetting('avatar.style', { value: { styleId: style.styleId } }, actorId)
  if (input.mode === 'newOnly') return result
  for (const ownerId of await owners(actorId)) {
    const counts = await db.$transaction(async tx => {
      await lockUserMutation(tx, ownerId)
      return applyOwner(tx, ownerId, style, input.includeCustom ?? false)
    }, { timeout: 30_000 })
    for (const key of Object.keys(counts) as Array<keyof ApplyCounts>) result[key] += counts[key]
  }
  return result
}
