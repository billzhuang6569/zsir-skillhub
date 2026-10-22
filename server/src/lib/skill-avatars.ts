import { createHash, randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { Prisma, type SkillAvatar } from '@prisma/client'
import { avatarGenerationEnabled } from './avatar-generation.js'
import { config } from '../config.js'
import { db } from '../db.js'
import { lockUserMutation } from './mutation-lock.js'
import { redactSensitiveContent } from './sensitive-content.js'
import { requestConfiguredAiDraft } from '../routes/skills.js'
import { SKILL_AVATAR_SYSTEM, SKILL_ART_FIXED_STYLE, SKILL_AVATAR_CANVAS, SKILL_AVATAR_PROMPT_VERSION } from './skill-avatar-prompt.js'
import { downloadFalAvatar, pollFalAvatar, submitFalAvatar, FalError } from './fal.js'
import { publicImageUrl, uploadMedia } from './media.js'
import { AvatarInput, type Input } from './skill-avatar-input.js'
import { imageSize, type ImageMimeType } from './image-dimensions.js'
import { ZodError } from 'zod'
import { AiRequestGuardError } from '../utils/ai-request-guard.js'
import { AiProviderHttpError, parseRetryAfterMs } from '../utils/retry-after.js'
import { mirrorSkillAvatar } from './avatar-model.js'
import { variantsMode, selectionAvatar, type SelectionDisplay, fillEmptyListingAvatar } from './avatar-selection.js'
import { createAvatarJob, readAvatarTask, selectCustomAvatar, restoreAvatarSelection, retryAvatarJob, persistAvatarJob, claimAvatarJob, availableJobs, mirrorAvatarJob, type AvatarTask } from './avatar-jobs.js'
import { getAvatarStyle } from './avatar-styles.js'
import { resolveAiConfig } from './ai-settings.js'
import { avatarDraftClientOnline, avatarDraftInput, avatarDraftWithCanvas, boundedAvatarInput, validAvatarDraft, AVATAR_DRAFT_DEADLINE_MS } from './local-ai-tasks.js'

export class AvatarError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    public readonly retryAfterSeconds?: number,
  ) { super(message); this.name = 'AvatarError' }
}

/** Seconds until the global daily quota resets at the next UTC midnight. */
export function secondsUntilNextUtcMidnight(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000))
}

export function sanitizeAvatarInput(input: Input): Input {
  const clean = (value: string): string => redactSensitiveContent(value).content
    .replace(/https?:\/\/[^\s]+/gi, '[LINK]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]')
    .replace(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s]+/g, '[PATH]')
  return { name: clean(input.name), description: clean(input.description), scenarios: input.scenarios.map(clean) }
}

export type AvatarSource = 'generated' | 'custom'
export type AvatarDisplay = Pick<SkillAvatar, 'url' | 'status'> & Partial<Pick<SkillAvatar, 'source' | 'customUrl'>> & { selection?: SelectionDisplay | null }
export type AvatarDto = { avatarUrl: string | null; avatarStatus: string; avatarSource: AvatarSource; selectionRevision?: number }

/**
 * What every surface shows for a task. A user upload (`source = 'custom'`) always
 * wins over the generation task, whatever state that task is in; otherwise only a
 * ready generated image is shown.
 */
export function avatarDto(avatar: AvatarDisplay): AvatarDto {
  if (variantsMode()) return { ...selectionAvatar(avatar.selection), ...(avatar.selection ? { selectionRevision: avatar.selection.revision } : {}) }
  if (avatar.source === 'custom' && avatar.customUrl) return { avatarUrl: avatar.customUrl, avatarStatus: 'ready', avatarSource: 'custom' }
  return { avatarUrl: avatar.status === 'ready' ? avatar.url : null,
    avatarStatus: ['ready', 'failed', 'needs_review'].includes(avatar.status) ? avatar.status : 'pending',
    avatarSource: 'generated' }
}

/** The `Skill.avatarUrl / avatarStatus` copy of `avatarDto`, written in the same transaction as the task. */
export function skillAvatarColumns(avatar: AvatarDisplay): { avatarUrl: string | null; avatarStatus: string } {
  const { avatarUrl, avatarStatus } = avatarDto(avatar)
  return { avatarUrl, avatarStatus }
}

/** Stable error code clients park on: two different tasks claim this identity. */
export const AVATAR_IDENTITY_CONFLICT = 'AVATAR_IDENTITY_CONFLICT'
/** Tasks explicitly retired by an authorized recovery; never a candidate, never returned. */
const SUPERSEDED = 'superseded'

type Tx = Prisma.TransactionClient

/**
 * Resolves one client-supplied key to the account's canonical task: the alias
 * table first (so an old key keeps finding the task it was folded into), then
 * the task keyed directly. Retired tasks never resolve.
 */
export async function resolveAvatarKey(transaction: Tx, ownerId: string, key: string): Promise<SkillAvatar | null> {
  const alias = await transaction.skillAvatarAlias.findUnique({ where: { ownerId_aliasLocalId: { ownerId, aliasLocalId: key } }, include: { avatar: true } })
  const found = alias?.avatar ?? await transaction.skillAvatar.findUnique({ where: { ownerId_localSkillId: { ownerId, localSkillId: key } } })
  return found && found.status !== SUPERSEDED && found.ownerId === ownerId ? variantsMode() ? readAvatarTask(transaction, found.id) : found : null
}

/**
 * Whether `localSkillId` (an account library entry) verifiably names the same
 * Skill as task `task`, using only facts the Server already holds: the task's
 * own cloud binding and the entry's author asset. A task without a cloud
 * binding carries no such fact, so it can never be linked to an entry — the
 * client's claimed alias and its requested `skillId` are not evidence about
 * the *old* task.
 */
async function entryBindsTask(transaction: Tx, ownerId: string, localSkillId: string, task: SkillAvatar, requestedSkillId?: string): Promise<boolean> {
  if (!task.skillId) return false
  if (requestedSkillId && task.skillId !== requestedSkillId) return false
  const entry = await transaction.libraryEntry.findFirst({ where: { id: localSkillId, userId: ownerId, deletedAt: null }, select: { authorSkillId: true } })
  return entry?.authorSkillId === task.skillId
}

async function registerAliases(transaction: Tx, ownerId: string, avatarId: string, aliases: string[]): Promise<void> {
  for (const aliasLocalId of aliases) {
    const existing = await transaction.skillAvatarAlias.findUnique({ where: { ownerId_aliasLocalId: { ownerId, aliasLocalId } } })
    if (existing && existing.avatarId !== avatarId) throw new AvatarError(409, '头像身份关联冲突', AVATAR_IDENTITY_CONFLICT)
    if (!existing) await transaction.skillAvatarAlias.create({ data: { ownerId, aliasLocalId, avatarId } })
  }
}

/**
 * The account's canonical avatar for a Skill identity.
 *
 * `localSkillId` is the stable identity the client derived (its library entry
 * id once the Skill is in the account library, else its device avatar id);
 * `aliasLocalIds` are the device ids that previously keyed this Skill. Every
 * key is resolved through the alias table first, so an old client that still
 * sends its device id keeps reaching the canonical task without being able to
 * rename it. Continuation (re-keying a task to the stable identity) happens
 * only when the server can verify entry ↔ author Skill; two different tasks
 * for one identity is a 409 the client parks on. Nothing is merged or deleted.
 */
export async function ensureSkillAvatar(options: AvatarIdentity): Promise<SkillAvatar> {
  const { ownerId, skillId } = identityOf(options)
  return db.$transaction(async (transaction): Promise<SkillAvatar> => {
    await lockUserMutation(transaction, ownerId)
    const resolved = await resolveAvatarIdentity(transaction, options)
    if (resolved.existing) {
      if (variantsMode()) {
        await mirrorAvatarJob(transaction, resolved.existing.id)
        await fillEmptyListingAvatar(transaction, ownerId, resolved.existing.skillId)
        return readAvatarTask(transaction, resolved.existing.id)
      }
      await mirrorSkillAvatar(transaction, resolved.existing.id)
      if (skillId) await transaction.skill.update({ where: { id: skillId }, data: skillAvatarColumns(resolved.existing) })
      return resolved.existing
    }
    // The task row and its ledger attempt commit together; a full day rolls both back.
    const created = await createAvatarTask(transaction, resolved, { status: 'queued', queuedAt: new Date() })
    if (variantsMode()) {
      await createAvatarJob(transaction, created, 'create')
      return readAvatarTask(transaction, created.id)
    }
    const queuedAt = await reserveAvatarGeneration(transaction, created.id, 'create')
    if (skillId) await transaction.skill.update({ where: { id: skillId }, data: { avatarStatus: 'pending' } })
    return { ...created, queuedAt }
  })
}

export type AvatarIdentity = { ownerId: string; localSkillId?: string; aliasLocalIds?: string[]; skillId?: string; input?: Input }
type ResolvedIdentity = { ownerId: string; localSkillId?: string; skillId?: string; aliasLocalIds: string[]; input?: Input; existing: SkillAvatar | null }

function identityOf(options: AvatarIdentity): { ownerId: string; localSkillId?: string; skillId?: string; aliasLocalIds: string[] } {
  const { ownerId, localSkillId, skillId } = options
  if (!localSkillId && !skillId) throw new AvatarError(400, '缺少 Skill 身份')
  const aliasLocalIds = Array.from(new Set((options.aliasLocalIds ?? []).filter((alias) => alias !== localSkillId)))
  return { ownerId, localSkillId, skillId, aliasLocalIds }
}

export type AvatarAttemptKind = 'create' | 'restore' | 'retry'

/** The UTC calendar day of `now`, as the `DATE` the ledger partitions on. */
export function utcDay(now: Date): Date {
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0); return day
}

/**
 * The only writer of the daily quota ledger (#221). Every new paid generation attempt
 * — a new task (`create`), 恢复自动生成 of a cancelled task (`restore`), a failed task
 * redrawn from scratch (`retry`) — calls this inside the transaction that makes the
 * status transition, after that conditional transition succeeded. Under the global
 * advisory lock it counts today's unreleased attempts; a full day throws 429 and the
 * caller's transaction rolls back the transition and leaves no attempt row. Otherwise
 * it records one attempt and stamps the task's `queuedAt` (display only).
 * Continuing an accepted request or a transfer is not a new paid attempt and never calls this.
 */
export async function reserveAvatarGeneration(transaction: Tx, avatarId: string, kind: AvatarAttemptKind): Promise<Date> {
  if (!avatarGenerationEnabled()) throw new AvatarError(503, '头像生成暂未开启', 'AVATAR_GENERATION_DISABLED')
  // ponytail: global daily-quota lock; use a quota row if enqueue throughput becomes material.
  await transaction.$queryRaw`SELECT pg_advisory_xact_lock(71382654)::text`
  const now = new Date()
  const day = utcDay(now)
  const used = await transaction.skillAvatarGenerationAttempt.count({ where: { day, releasedAt: null } })
  if (used >= config.SKILL_AVATAR_DAILY_LIMIT) {
    throw new AvatarError(429, '头像生成额度已达上限，请稍后重试', 'AVATAR_DAILY_QUOTA', secondsUntilNextUtcMidnight(now))
  }
  await transaction.skillAvatar.update({ where: { id: avatarId }, data: { queuedAt: now } })
  const jobId = await mirrorSkillAvatar(transaction, avatarId, true)
  await transaction.skillAvatarGenerationAttempt.create({ data: { avatarId, jobId, day, kind, createdAt: now } })
  return now
}

/** Refund: the task's latest unreleased attempt never reached a paid request (an unclaimed queued task was cancelled). */
async function releaseLatestAttempt(transaction: Tx, avatarId: string): Promise<void> {
  const avatar = await transaction.skillAvatar.findUniqueOrThrow({ where: { id: avatarId } })
  const latest = await transaction.skillAvatarGenerationAttempt.findFirst({ where: { avatarId, jobId: avatar.currentJobId, releasedAt: null }, orderBy: { createdAt: 'desc' } })
  if (latest) await transaction.skillAvatarGenerationAttempt.update({ where: { id: latest.id }, data: { releasedAt: new Date() } })
}

/** A new task for a resolved identity; the device ids that keyed it before resolve to it from now on. */
async function createAvatarTask(transaction: Tx, resolved: ResolvedIdentity,
  data: { status: 'queued'; queuedAt: Date } | { id: string; status: 'cancelled'; queuedAt: null; source: 'custom'; customAssetId: string; customUrl: string; customUpdatedAt: Date }): Promise<SkillAvatar> {
  const sanitized = sanitizeAvatarInput(AvatarInput.parse(resolved.input))
  const result = await transaction.skillAvatar.create({ data: {
    ...data, ownerId: resolved.ownerId, localSkillId: resolved.localSkillId, skillId: resolved.skillId, input: sanitized,
    inputFingerprint: createHash('sha256').update(JSON.stringify(sanitized)).digest('hex'),
    promptVersion: SKILL_AVATAR_PROMPT_VERSION,
  } })
  await registerAliases(transaction, resolved.ownerId, result.id, resolved.aliasLocalIds)
  return result
}

/**
 * Identity resolution shared by ensure and the custom upload: the cloud Skill's input,
 * alias-first candidates, conflicts, verifiable continuation and alias registration of
 * an existing task. Never creates a task and never touches quota.
 */
async function resolveAvatarIdentity(transaction: Tx, options: AvatarIdentity): Promise<ResolvedIdentity> {
  const { ownerId, localSkillId, skillId, aliasLocalIds } = identityOf(options)
  {
    let input = options.input
    if (skillId) {
      const skill = await transaction.skill.findFirst({ where: { id: skillId, authorId: ownerId, deletedAt: null },
        ...(variantsMode() ? { select: { displayName: true, description: true, triggerScenarios: true } } : {}) })
      if (!skill) throw new AvatarError(404, 'Skill 不存在')
      // A listing's reviewed snapshot is the only source for publicly distributed Skills.
      const listing = await transaction.marketplaceListing.findUnique({ where: { skillId }, include: { submission: true } })
      const source = listing?.submission.status === 'approved' && !listing.withdrawnAt ? listing.submission : skill
      input = { name: source.displayName, description: source.description || source.displayName,
        scenarios: Array.isArray(source.triggerScenarios) ? source.triggerScenarios.filter((v): v is string => typeof v === 'string').slice(0, 8) : [] }
    }
    const candidates = new Map<string, SkillAvatar>()
    for (const key of [localSkillId, ...aliasLocalIds]) {
      if (!key) continue
      const found = await resolveAvatarKey(transaction, ownerId, key)
      if (found) candidates.set(found.id, found)
    }
    if (skillId) {
      const cloud = await transaction.skillAvatar.findUnique({ where: { skillId } })
      if (cloud && cloud.status !== SUPERSEDED) {
        if (cloud.ownerId !== ownerId) throw new AvatarError(409, '头像身份关联冲突', AVATAR_IDENTITY_CONFLICT)
        candidates.set(cloud.id, cloud)
      }
    }
    if (candidates.size > 1) throw new AvatarError(409, 'Skill 已有另一头像关联，请核对身份', AVATAR_IDENTITY_CONFLICT)
    const existing = candidates.values().next().value as SkillAvatar | undefined
    if (existing) {
      if (existing.skillId && skillId && existing.skillId !== skillId) throw new AvatarError(409, '头像身份关联冲突', AVATAR_IDENTITY_CONFLICT)
      const data: Prisma.SkillAvatarUpdateInput = skillId && !existing.skillId ? { skill: { connect: { id: skillId } } } : {}
      const toRegister = new Set(aliasLocalIds)
      // An old client whose key is already an alias of this task keeps reaching
      // it; the canonical id is never renamed to an older key.
      const requestKeyIsAlias = localSkillId !== undefined && existing.localSkillId !== localSkillId
        && (await transaction.skillAvatarAlias.findUnique({ where: { ownerId_aliasLocalId: { ownerId, aliasLocalId: localSkillId } } }))?.avatarId === existing.id
      if (localSkillId && existing.localSkillId !== localSkillId && !requestKeyIsAlias) {
        // Continuation: the request names a newer stable identity for a task
        // keyed by an older (or no) local id. Allowed only when the old key is
        // one of this request's aliases (or absent) AND the entry verifiably
        // belongs to the task's cloud Skill. Otherwise the two ids are not
        // proven to be one Skill: park, never rebind on the client's word.
        const oldKey = existing.localSkillId
        const claimed = oldKey === null || aliasLocalIds.includes(oldKey)
        if (!claimed || !await entryBindsTask(transaction, ownerId, localSkillId, existing, skillId)) {
          throw new AvatarError(409, '头像身份关联冲突', AVATAR_IDENTITY_CONFLICT)
        }
        const taken = await transaction.skillAvatar.findUnique({ where: { ownerId_localSkillId: { ownerId, localSkillId } } })
        if (taken && taken.id !== existing.id) throw new AvatarError(409, '头像身份关联冲突', AVATAR_IDENTITY_CONFLICT)
        data.localSkillId = localSkillId
        if (oldKey) toRegister.add(oldKey)
      }
      await registerAliases(transaction, ownerId, existing.id, Array.from(toRegister))
      const result = Object.keys(data).length > 0
        ? await transaction.skillAvatar.update({ where: { id: existing.id }, data })
        : existing
      if (Object.keys(data).length > 0) {
        if (variantsMode()) await mirrorAvatarJob(transaction, result.id)
        else await mirrorSkillAvatar(transaction, result.id)
      }
      return { ownerId, localSkillId, skillId, aliasLocalIds, input, existing: result }
    }
    return { ownerId, localSkillId, skillId, aliasLocalIds, input, existing: null }
  }
}

export type CustomAvatarImage = { mimeType: ImageMimeType; dataBase64: string }
export const CUSTOM_AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const CUSTOM_AVATAR_MIN_SIZE = 256
export const CUSTOM_AVATAR_MAX_SIZE = 1024
const CUSTOM_AVATAR_EXTENSIONS: Record<ImageMimeType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

/** A cropped upload: ≤ 2 MB, magic bytes of its declared type, square 256–1024 px read from the header. */
export function prepareCustomAvatar(image: CustomAvatarImage): { bytes: Buffer; sha256: string } {
  if (image.dataBase64.length === 0 || image.dataBase64.length > Math.ceil(CUSTOM_AVATAR_MAX_BYTES / 3) * 4 + 4) {
    throw new AvatarError(400, '请上传 2 MB 以内的头像图片', 'AVATAR_IMAGE_TOO_LARGE')
  }
  const bytes = Buffer.from(image.dataBase64, 'base64')
  if (bytes.length === 0 || bytes.length > CUSTOM_AVATAR_MAX_BYTES) throw new AvatarError(400, '请上传 2 MB 以内的头像图片', 'AVATAR_IMAGE_TOO_LARGE')
  const size = bytes.toString('base64') === image.dataBase64 ? imageSize(bytes, image.mimeType) : null
  if (!size) throw new AvatarError(400, '图片内容无效', 'AVATAR_IMAGE_INVALID')
  if (size.width !== size.height || size.width < CUSTOM_AVATAR_MIN_SIZE || size.width > CUSTOM_AVATAR_MAX_SIZE) {
    throw new AvatarError(400, '头像须为 256–1024 像素的正方形图片', 'AVATAR_IMAGE_DIMENSIONS')
  }
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/**
 * A user's own image replaces whatever is displayed for this Skill, whatever the
 * generation task is doing. Only the display columns are written; the generation
 * fields, lease and status stay with the worker, so an in-flight paid request still
 * records its `requestId`, assets or `needs_review`. The one exception is a task
 * nobody has started yet (`queued`, no lease): it is cancelled so it never costs.
 * Without a task, an upload-only `cancelled` row is created with the request's
 * sanitized input and `queuedAt = NULL`, so it never uses quota.
 */
export async function uploadCustomAvatar(options: AvatarIdentity & { image: CustomAvatarImage }): Promise<SkillAvatar> {
  const { ownerId } = identityOf(options)
  const prepared = prepareCustomAvatar(options.image)
  // Resolve first (no task is created here) so the Picem upload carries the task id.
  const planned = await db.$transaction(async (transaction): Promise<{ id: string }> => {
    await lockUserMutation(transaction, ownerId)
    const resolved = await resolveAvatarIdentity(transaction, options)
    if (!resolved.existing) AvatarInput.parse(resolved.input)
    return { id: resolved.existing?.id ?? randomUUID() }
  }).catch((error: unknown) => {
    if (error instanceof AvatarError) throw error
    if (error instanceof ZodError) throw new AvatarError(400, '缺少用于头像的 Skill 介绍', 'AVATAR_INPUT_REQUIRED')
    throw error
  })
  const asset = await uploadMedia(prepared.bytes, options.image.mimeType, `${planned.id}-custom.${CUSTOM_AVATAR_EXTENSIONS[options.image.mimeType]}`, {
    purpose: 'avatar', visibility: 'public', ownerRef: `skill-avatar:${planned.id}:custom:${prepared.sha256}`, userId: ownerId,
  })
  if (!asset.url) throw new AvatarError(503, '头像服务暂时不可用，请稍后重试', 'AVATAR_UPLOAD_UNAVAILABLE')
  const custom = { source: 'custom' as const, customAssetId: asset.assetId, customUrl: publicImageUrl(asset.url), customUpdatedAt: new Date() }
  return db.$transaction(async (transaction): Promise<SkillAvatar> => {
    await lockUserMutation(transaction, ownerId)
    const resolved = await resolveAvatarIdentity(transaction, options)
    let result: SkillAvatar
    if (variantsMode()) {
      const anchor = resolved.existing ?? await createAvatarTask(transaction, resolved, { id: planned.id, status: 'cancelled', queuedAt: null, ...custom })
      if (!resolved.existing) await createAvatarJob(transaction, anchor, null)
      return selectCustomAvatar(transaction, anchor, custom)
    }
    if (resolved.existing) {
      await transaction.skillAvatar.update({ where: { id: resolved.existing.id }, data: custom })
      // Unpaid and unclaimed: cancel so the queue never spends money on an image nobody will
      // see, and refund the attempt that queued it. A claimed or in-flight task keeps its attempt.
      const cancelled = await transaction.skillAvatar.updateMany({ where: { id: resolved.existing.id, status: 'queued', leaseToken: null, submittedAt: null, requestId: null }, data: { status: 'cancelled' } })
      if (cancelled.count === 1) await releaseLatestAttempt(transaction, resolved.existing.id)
      result = await transaction.skillAvatar.findUniqueOrThrow({ where: { id: resolved.existing.id } })
    } else {
      result = await createAvatarTask(transaction, resolved, { id: planned.id, status: 'cancelled', queuedAt: null, ...custom })
    }
    await mirrorSkillAvatar(transaction, result.id)
    if (result.skillId) await transaction.skill.updateMany({ where: { id: result.skillId, deletedAt: null }, data: skillAvatarColumns(result) })
    return result
  })
}

export const AVATAR_CUSTOM_ACTIVE = 'AVATAR_CUSTOM_ACTIVE'

/** The owner's task for a local key (alias-first) or an authored cloud Skill; null when not theirs. */
export async function findOwnedAvatar(transaction: Tx, ownerId: string, key: { localSkillId: string } | { skillId: string }): Promise<SkillAvatar | null> {
  if ('localSkillId' in key) return resolveAvatarKey(transaction, ownerId, key.localSkillId)
  const skill = await transaction.skill.findFirst({ where: { id: key.skillId, authorId: ownerId, deletedAt: null }, select: { id: true } })
  if (!skill) return null
  const avatar = await transaction.skillAvatar.findUnique({ where: { skillId: key.skillId } })
  return avatar && avatar.ownerId === ownerId && avatar.status !== SUPERSEDED ? variantsMode() ? readAvatarTask(transaction, avatar.id) : avatar : null
}

/**
 * 恢复自动生成. Clears the custom image and shows the generation task again:
 * ready → its image; failed / needs_review / in flight → unchanged (needs_review is
 * never queued again); cancelled → reserve quota and queue it. When quota is full or
 * generation is disabled the whole restore fails and the custom image stays.
 * Restoring a task that already shows its generated image is a no-op.
 */
export async function restoreGeneratedAvatar(ownerId: string, key: { localSkillId: string } | { skillId: string }): Promise<SkillAvatar> {
  return db.$transaction(async (transaction): Promise<SkillAvatar> => {
    await lockUserMutation(transaction, ownerId)
    const avatar = await findOwnedAvatar(transaction, ownerId, key)
    if (!avatar) throw new AvatarError(404, '头像不存在')
    if (variantsMode()) return restoreAvatarSelection(transaction, avatar)
    if (avatar.source !== 'custom') return avatar
    const generated = { source: 'generated', customAssetId: null, customUrl: null, customUpdatedAt: null }
    if (avatar.status === 'cancelled') {
      // Conditional transition first; only the request that moved it records an attempt.
      // A full day rolls back the transition, so the custom image and `source` stay.
      const moved = await transaction.skillAvatar.updateMany({ where: { id: avatar.id, status: 'cancelled' }, data: {
        ...generated, status: 'queued', attempts: 0, errorCode: null, nextAttemptAt: new Date(),
      } })
      if (moved.count === 1) await reserveAvatarGeneration(transaction, avatar.id, 'restore')
    } else {
      await transaction.skillAvatar.update({ where: { id: avatar.id }, data: generated })
    }
    const result = await transaction.skillAvatar.findUniqueOrThrow({ where: { id: avatar.id } })
    await mirrorSkillAvatar(transaction, result.id)
    if (result.skillId) await transaction.skill.updateMany({ where: { id: result.skillId, deletedAt: null }, data: skillAvatarColumns(result) })
    return result
  })
}

/**
 * 重新生成 a failed task. With saved image bytes / URL it resumes the transfer, with a
 * `requestId` it resumes polling that request — neither is a new paid attempt, so no
 * quota check and no ledger row. With neither it is redrawn from scratch: a `retry`
 * attempt is reserved in the same transaction. The transition is conditional
 * (`failed`, no lease), so concurrent or repeated requests move it once and only that
 * request spends quota; the others get `transitioned: false` and the current row.
 * A full day throws 429 and leaves `failed` / `errorCode` as they were.
 */
/**
 * Where 重新生成 would move a task: only an unclaimed `failed` task moves; saved image bytes /
 * URL resume the transfer, a `requestId` resumes polling (both free), otherwise it is redrawn
 * (`queued`, a paid attempt). Shared by the API retry and the ops `retry` preview (#246).
 */
export function retryTarget(avatar: Pick<SkillAvatar, 'status' | 'leaseToken' | 'imageData' | 'imageUrl' | 'requestId'> & Partial<Pick<SkillAvatar, 'assetId' | 'url' | 'submittedAt'>>): 'queued' | 'awaiting' | 'transferring' | null {
  if (avatar.status !== 'failed' || avatar.leaseToken !== null) return null
  return (avatar.assetId && avatar.url) || avatar.imageData || avatar.imageUrl ? 'transferring' : avatar.requestId ? 'awaiting' : avatar.submittedAt ? null : 'queued'
}

/** Today's (UTC) generation quota from the #221 ledger: limit, unreleased attempts and what is left. */
export async function avatarQuotaToday(now: Date = new Date()): Promise<{ day: string; limit: number; used: number; remaining: number }> {
  const day = utcDay(now)
  const used = await db.skillAvatarGenerationAttempt.count({ where: { day, releasedAt: null } })
  return { day: day.toISOString().slice(0, 10), limit: config.SKILL_AVATAR_DAILY_LIMIT, used, remaining: Math.max(0, config.SKILL_AVATAR_DAILY_LIMIT - used) }
}

export async function retryFailedAvatar(ownerId: string, avatarId: string): Promise<{ transitioned: boolean; avatar: SkillAvatar }> {
  if (variantsMode()) return retryAvatarJob(ownerId, avatarId)
  return db.$transaction(async (transaction) => {
    const current = await transaction.skillAvatar.findUniqueOrThrow({ where: { id: avatarId } })
    // The conditional update below is what decides; the target only depends on saved artefacts.
    const status = retryTarget({ ...current, status: 'failed', leaseToken: null })
    if (!status) return { transitioned: false, avatar: current }
    const moved = await transaction.skillAvatar.updateMany({ where: { id: avatarId, status: 'failed', leaseToken: null },
      data: { status, attempts: 0, errorCode: null, nextAttemptAt: new Date() } })
    const transitioned = moved.count === 1
    if (transitioned && status === 'queued') await reserveAvatarGeneration(transaction, avatarId, 'retry')
    else if (transitioned) await mirrorSkillAvatar(transaction, avatarId)
    if (transitioned && current.skillId) await transaction.skill.updateMany({
      where: { id: current.skillId, authorId: ownerId, deletedAt: null }, data: { avatarStatus: 'pending' },
    })
    return { transitioned, avatar: await transaction.skillAvatar.findUniqueOrThrow({ where: { id: avatarId } }) }
  })
}

export async function queueCloudAvatar(ownerId: string, skillId: string, localSkillId?: string, aliasLocalIds?: string[]): Promise<void> {
  if (!avatarGenerationEnabled() && !localSkillId) return
  await ensureSkillAvatar({ ownerId, skillId, localSkillId, aliasLocalIds })
}

/**
 * Author-asset publishing binds an already registered avatar (the one keyed
 * by the library entry id the device registered) to the new cloud Skill. It
 * never creates a task: without the device's identity it cannot tell whether
 * an older local task exists, so a missing registration is left for the next
 * device pass instead of risking a second paid task. Returns whether a task
 * is now bound, so callers can show "待登记" honestly.
 */
export async function bindCloudAvatarToEntry(ownerId: string, skillId: string, entryId: string): Promise<boolean> {
  return db.$transaction(async (transaction): Promise<boolean> => {
    await lockUserMutation(transaction, ownerId)
    if (variantsMode() && !await transaction.skill.findFirst({ where: { id: skillId, authorId: ownerId, deletedAt: null }, select: { id: true } })) return false
    const task = await transaction.skillAvatar.findUnique({ where: { ownerId_localSkillId: { ownerId, localSkillId: entryId } } })
    if (!task || task.status === SUPERSEDED) return false
    if (task.skillId && task.skillId !== skillId) return false
    if (!task.skillId) {
      const other = await transaction.skillAvatar.findUnique({ where: { skillId } })
      if (other && other.id !== task.id) return false
      const bound = await transaction.skillAvatar.update({ where: { id: task.id }, data: { skill: { connect: { id: skillId } } } })
      if (variantsMode()) {
        await mirrorAvatarJob(transaction, task.id)
        await fillEmptyListingAvatar(transaction, ownerId, skillId)
        return true
      }
      await mirrorSkillAvatar(transaction, task.id)
      await transaction.skill.update({ where: { id: skillId }, data: skillAvatarColumns(bound) })
    }
    return true
  })
}

/** Alias keys per avatar id, for the client's canonical + alias read-back. */
export async function avatarAliasesByAvatar(ownerId: string, avatarIds: string[]): Promise<Map<string, string[]>> {
  const rows = avatarIds.length === 0 ? [] : await db.skillAvatarAlias.findMany({ where: { ownerId, avatarId: { in: avatarIds } }, select: { avatarId: true, aliasLocalId: true } })
  const result = new Map<string, string[]>()
  for (const row of rows) result.set(row.avatarId, [...(result.get(row.avatarId) ?? []), row.aliasLocalId].sort())
  return result
}

const ACTIVE = ['queued', 'drafting', 'prompting', 'submitting', 'awaiting', 'transferring']
const LEASE_MS = 180_000 // Longer than the bounded LLM/download/Picem calls in one step.
/** Cadence between successful steps (e.g. polling an accepted request). */
export const AVATAR_STEP_INTERVAL_MS = 15_000
/** Exponential backoff for transient failures: 15 s, 30 s, 1 m, 2 m, 4 m … capped. */
export const AVATAR_BACKOFF_CAP_MS = 30 * 60_000
/** A transient failure terminates on this many attempts; quota waits are not attempts. */
export const AVATAR_MAX_ATTEMPTS = 5

export type AvatarStage = 'prompting' | 'awaiting' | 'transferring'
export type AvatarFailureKind = 'quota' | 'transient' | 'terminal'

/**
 * A worker failure classified by stage and kind. `code` is persisted as
 * `errorCode`; it names the stage and the mechanism (guard window, timeout,
 * HTTP status, network, provider result) but never carries provider bodies,
 * prompts or identities.
 */
export type AvatarFailure = {
  code: string
  stage: AvatarStage
  kind: AvatarFailureKind
  /** Minimum wait demanded by the limiter / upstream; honoured, never shortened. */
  retryAfterMs: number | null
}

const TERMINAL_CODES = new Set([
  'invalid_drawing_prompt', 'missing_request_id', 'missing_image_url', 'fal_generation_failed',
  'fal_invalid_result', 'fal_http_422', 'fal_invalid_image_url', 'invalid_avatar_jpeg', 'invalid_avatar_dimensions',
])

/** Stage of an active task from its status; `submitting` is quarantined before classification. */
export function avatarStage(status: string): AvatarStage {
  if (status === 'awaiting') return 'awaiting'
  if (status === 'transferring') return 'transferring'
  return 'prompting'
}

function httpStatusOf(error: Error): number | null {
  const own = (error as { status?: unknown; statusCode?: unknown })
  for (const value of [own.status, own.statusCode]) {
    if (typeof value === 'number' && value >= 100 && value <= 599) return value
  }
  const match = /HTTP (\d{3})\b/.exec(error.message)
  return match ? Number(match[1]) : null
}

/**
 * The upstream wait attached to an error: our adapters (`AiProviderHttpError`,
 * `FalError`) carry `retryAfterMs` directly; the OpenAI SDK's `APIError`
 * exposes the response headers (a `Headers` or a plain record). Delta-seconds
 * and HTTP-date are both honoured; a malformed header is "no wait stated".
 */
function retryAfterHeaderMs(error: Error): number | null {
  const direct = (error as { retryAfterMs?: unknown }).retryAfterMs
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct
  const headers = (error as { headers?: unknown }).headers
  let value: unknown = null
  if (headers instanceof Headers) value = headers.get('retry-after')
  else if (headers && typeof headers === 'object') {
    const record = headers as Record<string, unknown>
    value = record['retry-after'] ?? record['Retry-After'] ?? null
  }
  return parseRetryAfterMs(typeof value === 'string' ? value : null)
}

function isTimeout(error: Error): boolean {
  return error.name === 'TimeoutError' || error.name === 'AbortError' || error.name === 'APIConnectionTimeoutError'
    || /\btime(?:d )?out\b/i.test(error.message)
}

function isNetwork(error: Error): boolean {
  const cause = (error as { cause?: unknown }).cause
  const causeCode = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined
  return error.name === 'APIConnectionError' || error.message === 'fetch failed'
    || (typeof causeCode === 'string' && /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR)/.test(causeCode))
}

/**
 * Classify a step failure. The AI request guard is checked first because a
 * limiter refusal is a wait, not a provider failure: it keeps its own
 * `Retry-After`, is attributed to the window that fired, and does not spend
 * the attempt budget. Unknown errors still name the stage instead of being
 * flattened into one generic code.
 */
export function classifyAvatarFailure(error: unknown, stage: AvatarStage): AvatarFailure {
  if (stage === 'prompting' && error instanceof AiProviderHttpError && error.upstreamCode === 'insufficient_user_quota') {
    return { code: 'prompt_insufficient_user_quota', stage, kind: 'terminal', retryAfterMs: null }
  }
  if (error instanceof AiRequestGuardError) {
    return { code: `ai_guard_${error.reason}`, stage, kind: 'quota', retryAfterMs: Math.max(1, error.retryAfterSeconds) * 1_000 }
  }
  if (error instanceof FalError) {
    return { code: error.code, stage, kind: TERMINAL_CODES.has(error.code) ? 'terminal' : 'transient',
      retryAfterMs: error.retryAfterMs }
  }
  const prefix = stage === 'prompting' ? 'prompt' : stage === 'awaiting' ? 'fal_poll' : 'transfer'
  if (!(error instanceof Error)) return { code: `${prefix}_failed`, stage, kind: 'transient', retryAfterMs: null }
  if (isTimeout(error)) return { code: `${prefix}_timeout`, stage, kind: 'transient', retryAfterMs: null }
  const status = httpStatusOf(error)
  if (status !== null) {
    return { code: `${prefix}_http_${status}`, stage, kind: 'transient', retryAfterMs: retryAfterHeaderMs(error) }
  }
  if (isNetwork(error)) return { code: `${prefix}_network`, stage, kind: 'transient', retryAfterMs: null }
  return { code: `${prefix}_failed`, stage, kind: 'transient', retryAfterMs: null }
}

/**
 * When the task may run again. Quota waits honour the limiter's remaining
 * window (a daily window can be hours; it is not clamped to the backoff cap and
 * does not assume a midnight reset). Transient failures back off
 * exponentially on the attempt count that this failure produced, and an
 * explicit upstream `Retry-After` is a floor, not a ceiling.
 */
export function nextAvatarAttemptAt(now: Date, failure: AvatarFailure | null, attemptsAfter: number): Date {
  if (!failure) return new Date(now.getTime() + AVATAR_STEP_INTERVAL_MS)
  if (failure.kind === 'quota') return new Date(now.getTime() + Math.max(AVATAR_STEP_INTERVAL_MS, failure.retryAfterMs ?? 0))
  const exponent = Math.max(0, Math.min(attemptsAfter - 1, 20))
  const backoff = Math.min(AVATAR_BACKOFF_CAP_MS, AVATAR_STEP_INTERVAL_MS * 2 ** exponent)
  return new Date(now.getTime() + Math.max(backoff, failure.retryAfterMs ?? 0))
}

async function persist(avatar: AvatarTask, data: Prisma.SkillAvatarUpdateManyMutationInput): Promise<boolean> {
  if (variantsMode()) return persistAvatarJob(avatar, data)
  return db.$transaction(async (transaction): Promise<boolean> => {
    const updated = await transaction.skillAvatar.updateMany({ where: { id: avatar.id, leaseToken: avatar.leaseToken,
      ...(data.status === 'submitting' ? { status: { in: ['queued', 'prompting'] }, submittedAt: null, requestId: null } : {}),
    }, data })
    if (updated.count !== 1) return false
    await mirrorSkillAvatar(transaction, avatar.id)
    // The Skill copy follows what the task row now displays (re-read in this transaction):
    // a generation result lands in the task's own fields but never replaces a custom image.
    const current = await transaction.skillAvatar.findUnique({ where: { id: avatar.id },
      select: { skillId: true, status: true, url: true, source: true, customUrl: true } })
    if (current?.skillId && typeof data.status === 'string') {
      await transaction.skill.updateMany({ where: { id: current.skillId, deletedAt: null }, data: skillAvatarColumns(current) })
    }
    return true
  })
}

export async function processAvatar(avatar: AvatarTask): Promise<void> {
  const job = variantsMode() ? avatar.job : undefined
  if (variantsMode() && !job) throw new Error('AVATAR_JOB_REQUIRED')
  const fal = job ? { model: job.falModel, parameters: job.falParameters as Record<string, Prisma.JsonValue> } : undefined
  if (avatar.status === 'submitting') {
    await persist(avatar, { status: 'needs_review', errorCode: 'submission_unknown' })
    return
  }
  if (avatar.status === 'queued' || avatar.status === 'prompting' || (job && avatar.status === 'drafting')) {
    if (config.SKILLHUB_PROFILE === 'selfhost' && !avatarGenerationEnabled()) return
    if (job) {
      const style = await getAvatarStyle(job.styleId, job.styleVersion)
      if (!style) throw new FalError('avatar_style_unavailable')
      const input = AvatarInput.parse(job.input)
      const bounded = boundedAvatarInput(input, style)
      let prompt = `${style.directPrompt}\n\n${JSON.stringify(bounded)}`
      let path: 'meta' | 'direct' = 'direct'
      let promptSource: 'instance' | 'local' | 'direct' = 'direct'
      if (job.promptSource === 'local' && job.prompt) {
        prompt = job.prompt; path = 'meta'; promptSource = 'local'
      } else if (avatar.status !== 'drafting') {
        let aiConfigured = false, aiUnavailable = false
        try { aiConfigured = await resolveAiConfig() !== null } catch { aiUnavailable = true }
        if (aiConfigured) {
          if (!await persist(avatar, { status: 'prompting' })) return
          try {
            const draft = (await requestConfiguredAiDraft(`avatar:${avatar.ownerId}`, style.metaPrompt, JSON.stringify(bounded), 'text', 'background'))?.trim()
            if (!draft || !validAvatarDraft(draft, style)) throw new FalError('invalid_drawing_prompt')
            prompt = avatarDraftWithCanvas(draft, style); path = 'meta'; promptSource = 'instance'
          } catch (error: unknown) {
            // Preserve the official guard's scheduled wait semantics.
            if (error instanceof AiRequestGuardError && config.SKILLHUB_PROFILE !== 'selfhost') throw error
          }
        } else if (!aiUnavailable && config.SKILLHUB_PROFILE === 'selfhost' && !job.draftDeadline
          && avatarDraftClientOnline(job.ownerId) && avatarDraftInput(input, style)) {
          const draftDeadline = new Date(Date.now() + AVATAR_DRAFT_DEADLINE_MS)
          await persistAvatarJob(avatar, { status: 'drafting', draftDeadline, nextAttemptAt: draftDeadline,
            leaseToken: null, leaseUntil: null })
          return
        }
      }
      if (config.SKILLHUB_PROFILE === 'selfhost' && !avatarGenerationEnabled()) return
      const fixed = style.fal[path]
      if (!await persistAvatarJob(avatar, { prompt, path, promptSource, falModel: fixed.model, falParameters: fixed.parameters,
        status: 'submitting', submittedAt: new Date() })) return
      let requestId: string
      try { requestId = await submitFalAvatar(prompt, fixed) } catch {
        await persist(avatar, { status: 'needs_review', errorCode: 'submission_unknown' })
        return
      }
      await persist(avatar, { requestId, status: 'awaiting', errorCode: null, attempts: 0 })
      return
    }
    // Background priority (#238): never the last AI slot or the users' share of the daily quota.
    if (!await persist(avatar, { status: 'prompting' })) return
    // A guard refusal is a scheduled wait in runClaimedAvatar (no attempt spent, no ledger row).
    const output = await requestConfiguredAiDraft(`avatar:${avatar.ownerId}`, SKILL_AVATAR_SYSTEM,
      JSON.stringify(avatar.input), 'text', 'background')
    const draft = output?.trim()
    if (!draft) throw new FalError('drawing_prompt_unavailable')
    if (draft.length < 300 || draft.length > 12_000 || /[\u4e00-\u9fff]/.test(draft)
      || !draft.includes(SKILL_ART_FIXED_STYLE) || redactSensitiveContent(draft).redactedSecrets > 0) {
      throw new FalError('invalid_drawing_prompt')
    }
    const prompt = draft + '\n\n' + SKILL_AVATAR_CANVAS
    // Commit intent before the only paid submission. Crash/unknown response is quarantined.
    if (!await persist(avatar, { prompt, status: 'submitting', submittedAt: new Date() })) return
    let requestId: string
    try { requestId = await submitFalAvatar(prompt) } catch {
      await persist(avatar, { status: 'needs_review', errorCode: 'submission_unknown' })
      return
    }
    await persist(avatar, { requestId, status: 'awaiting', errorCode: null, attempts: 0 })
    return
  }
  if (avatar.status === 'awaiting') {
    if (!avatar.requestId) throw new FalError('missing_request_id')
    const imageUrl = fal ? await pollFalAvatar(avatar.requestId, fal) : await pollFalAvatar(avatar.requestId)
    if (imageUrl) await persist(avatar, { imageUrl, status: 'transferring', attempts: 0, errorCode: null })
    return
  }
  if (avatar.status === 'transferring') {
    let asset = { assetId: avatar.assetId, url: avatar.url }
    if (!asset.assetId || !asset.url) {
      let bytes = avatar.imageData
      if (!bytes) {
        if (!avatar.imageUrl) throw new FalError('missing_image_url')
        bytes = await downloadFalAvatar(avatar.imageUrl)
        if (!await persist(avatar, { imageData: bytes, imageSha256: createHash('sha256').update(bytes).digest('hex') })) return
      }
      asset = await uploadMedia(bytes, 'image/jpeg', `${avatar.id}.jpg`, {
        purpose: 'avatar', visibility: 'public', ownerRef: `skill-avatar:${avatar.id}`, userId: avatar.ownerId,
      })
      // Retain accepted asset identity even when CDN readiness needs another attempt.
      if (!await persist(avatar, { assetId: asset.assetId, url: asset.url })) return
    }
    if (!asset.url) throw new FalError('picem_not_public')
    const url = publicImageUrl(asset.url)
    // Builtin uploads confirm durable storage before returning; only Picem needs CDN readiness.
    if (config.SKILLHUB_PROFILE !== 'selfhost') {
      const response = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(15_000) })
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new FalError('picem_link_unavailable')
    }
    if (!await persist(avatar, { status: 'ready', assetId: asset.assetId, url, imageData: null, imageUrl: null, errorCode: null })) return
  }
}

/**
 * Worker lanes (#235). `generate` covers the paid, rate-limited first step (LLM drawing
 * prompt → the one FAL submission; a stale `submitting` is quarantined here too) and has
 * its own, smaller limit. `deliver` covers polling an accepted request and the Picem
 * transfer, which may use every remaining slot.
 */
export const AVATAR_LANES = {
  generate: ['queued', 'drafting', 'prompting', 'submitting'],
  deliver: ['awaiting', 'transferring'],
} as const satisfies Record<string, readonly string[]>
export type AvatarLane = keyof typeof AVATAR_LANES
/** How many available tasks one claim looks at to find the fairest owner (bounded scan, ids only). */
const CLAIM_SCAN = 2_000

const availableWhere = (statuses: readonly string[], now: Date): Prisma.SkillAvatarWhereInput => ({
  status: { in: [...statuses] }, nextAttemptAt: { lte: now },
  OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
})

/**
 * Claims one available task, or null. Fair: each owner's earliest due task competes, and
 * owners with fewer tasks currently leased go first (ties by `nextAttemptAt`, then
 * `createdAt`), so a user's bulk import gets at most its turn in every round instead of
 * starving another user's single task. The claim itself is the existing conditional
 * update — status still active, due, and no live lease — so concurrent claimers (slots in
 * this process, other processes) can never both hold one task: the loser's update matches
 * 0 rows and it moves on to the next candidate.
 */
export async function claimAvatar(statuses: readonly string[] = ACTIVE, now: Date = new Date()): Promise<SkillAvatar | null> {
  if (config.SKILLHUB_PROFILE === 'selfhost' && !avatarGenerationEnabled()) {
    // Public image downloads and durable transfer need no fal credential.
    statuses = statuses.filter(status => status === 'transferring')
    if (!statuses.length) return null
  }
  if (variantsMode()) return claimAvatarJob(statuses, now)
  const available = availableWhere(statuses, now)
  const due = await db.skillAvatar.findMany({ where: available, select: { id: true, ownerId: true },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: CLAIM_SCAN })
  if (!due.length) return null
  const heads = new Map<string, { id: string; rank: number }>()
  due.forEach((row, rank) => { if (!heads.has(row.ownerId)) heads.set(row.ownerId, { id: row.id, rank }) })
  const leased = await db.skillAvatar.groupBy({ by: ['ownerId'], where: { ownerId: { in: [...heads.keys()] }, leaseUntil: { gte: now } }, _count: { _all: true } })
  const busy = new Map(leased.map(row => [row.ownerId, row._count._all]))
  const order = [...heads].sort(([leftOwner, left], [rightOwner, right]) => (busy.get(leftOwner) ?? 0) - (busy.get(rightOwner) ?? 0) || left.rank - right.rank)
  // Each owner's head first; if all of those were taken by a concurrent claimer, the rest in due order.
  const tried = new Set<string>()
  for (const id of [...order.map(([, head]) => head.id), ...due.map(row => row.id)]) {
    if (tried.has(id)) continue
    tried.add(id)
    const leaseToken = randomUUID()
    const row = await db.$transaction(async (transaction): Promise<SkillAvatar | null> => {
      const claimed = await transaction.skillAvatar.updateMany({ where: { ...available, id }, data: { leaseToken, leaseUntil: new Date(now.getTime() + LEASE_MS) } })
      if (claimed.count !== 1) return null
      await mirrorSkillAvatar(transaction, id)
      return transaction.skillAvatar.findFirst({ where: { id, leaseToken } })
    })
    if (row) return { ...row, leaseToken }
  }
  return null
}

/** Whether any task of these statuses is due now (cheap count for the worker's aggregate log). */
async function dueCount(statuses: readonly string[], now: Date): Promise<number> {
  if (variantsMode()) return db.avatarGenerationJob.count({ where: availableJobs(statuses, now) })
  return db.skillAvatar.count({ where: availableWhere(statuses, now) })
}

export async function runAvatarWorkerOnce(logger: FastifyBaseLogger): Promise<void> {
  if (config.SKILLHUB_PROFILE !== 'selfhost' && !avatarGenerationEnabled()) return
  const avatar = await claimAvatar(ACTIVE)
  if (avatar) await runClaimedAvatar(avatar, logger)
}

/** One step of a claimed task: failure classification, retry budget and lease release are unchanged by #235. */
export async function runClaimedAvatar(avatar: SkillAvatar, logger: FastifyBaseLogger): Promise<void> {
  const leaseToken = avatar.leaseToken
  let failure: AvatarFailure | null = null
  let attemptsAfter = avatar.attempts
  try {
    if (avatar.skillId && !await db.skill.findFirst({ where: { id: avatar.skillId, deletedAt: null }, select: { id: true } })) {
      await persist(avatar, { status: 'failed', errorCode: 'skill_deleted' })
    } else await processAvatar(avatar)
  } catch (error: unknown) {
    failure = classifyAvatarFailure(error, avatarStage(avatar.status))
    if (failure.kind === 'quota') {
      // A limiter refusal is a scheduled wait: record why, keep the attempt budget.
      await persist(avatar, { errorCode: failure.code })
    } else {
      attemptsAfter = avatar.attempts + 1
      await persist(avatar, { errorCode: failure.code, attempts: { increment: 1 },
        ...((failure.kind === 'terminal' || attemptsAfter >= AVATAR_MAX_ATTEMPTS) ? { status: 'failed' } : {}) })
    }
    logger.warn({ avatarId: avatar.id, code: failure.code, stage: failure.stage, kind: failure.kind,
      retryAfterMs: failure.retryAfterMs, attempts: attemptsAfter }, 'Skill avatar step failed')
  } finally {
    // The lease release is the only place that schedules the next run, so the
    // wait computed from the failure (including Retry-After) is never
    // overwritten by a fixed interval.
    if (variantsMode()) await persist(avatar, { leaseToken: null, leaseUntil: null, nextAttemptAt: nextAvatarAttemptAt(new Date(), failure, attemptsAfter) })
    else await db.$transaction(async (transaction): Promise<void> => {
      const released = await transaction.skillAvatar.updateMany({ where: { id: avatar.id, leaseToken }, data: {
        leaseToken: null, leaseUntil: null, nextAttemptAt: nextAvatarAttemptAt(new Date(), failure, attemptsAfter),
      } })
      if (released.count === 1) await mirrorSkillAvatar(transaction, avatar.id)
    })
  }
}

export type AvatarWorkerLimits = { total: number; generate: number }

/**
 * Bounded-concurrency pool (#235): up to `total` steps run at once, of which at most
 * `generate` are in the paid generate lane; the deliver lane may use every remaining slot.
 * Filling alternates the lane tried first so neither lane starves the other. A finished
 * step frees its slot and refills at once; a 5 s tick picks up newly due work. Stopping
 * claims nothing new and waits for running steps; a step cut off by a crash is released
 * by lease expiry (180 s) and claimed again (a stale `submitting` goes to needs_review).
 */
export function createAvatarWorkerPool(logger: FastifyBaseLogger, limits: AvatarWorkerLimits, claim: (statuses: readonly string[]) => Promise<SkillAvatar | null> = claimAvatar,
  run: (avatar: SkillAvatar, logger: FastifyBaseLogger) => Promise<void> = runClaimedAvatar, clock: () => number = Date.now) {
  const inFlight: Record<AvatarLane, number> = { generate: 0, deliver: 0 }
  const running = new Set<Promise<void>>()
  let stopped = false
  let filling: Promise<void> | null = null
  let firstLane: AvatarLane = 'generate'
  let lastReport = ''
  const capacity = (lane: AvatarLane): boolean => inFlight.generate + inFlight.deliver < limits.total
    && (lane === 'deliver' || inFlight.generate < limits.generate)
  const start = (lane: AvatarLane, avatar: SkillAvatar): void => {
    inFlight[lane] += 1
    const step: Promise<void> = run(avatar, logger).catch(() => { logger.warn('Skill avatar worker step unavailable') })
      .finally(() => { inFlight[lane] -= 1; running.delete(step); void fill() })
    running.add(step)
  }
  const fillOnce = async (): Promise<void> => {
    if (config.SKILLHUB_PROFILE !== 'selfhost' && !avatarGenerationEnabled()) return
    for (;;) {
      if (stopped) return
      const lanes: AvatarLane[] = firstLane === 'generate' ? ['generate', 'deliver'] : ['deliver', 'generate']
      firstLane = firstLane === 'generate' ? 'deliver' : 'generate'
      let started = false
      for (const lane of lanes) {
        if (stopped || !capacity(lane)) continue
        if (lane === 'generate' && !avatarGenerationEnabled()) continue
        const avatar = await claim(AVATAR_LANES[lane])
        if (!avatar) continue
        if (stopped) {
          if (variantsMode()) await persist(avatar, { leaseToken: null, leaseUntil: null })
          else await db.$transaction(async (transaction): Promise<void> => {
            const released = await transaction.skillAvatar.updateMany({ where: { id: avatar.id, leaseToken: avatar.leaseToken }, data: { leaseToken: null, leaseUntil: null } })
            if (released.count === 1) await mirrorSkillAvatar(transaction, avatar.id)
          })
          return
        }
        start(lane, avatar); started = true
        break
      }
      if (!started) return
    }
  }
  // One filler at a time; a request that arrives while it runs (a step just freed its slot)
  // makes it run once more, so a freed slot is never left idle until the next tick.
  let again = false
  const fill = (): Promise<void> => {
    if (filling) { again = true; return filling }
    filling = (async (): Promise<void> => {
      do { again = false; await fillOnce().catch(() => { logger.warn('Skill avatar worker unavailable') }) } while (again && !stopped)
    })().finally(() => { filling = null })
    return filling
  }
  /**
   * Aggregate counts only: no task ids, prompts, URLs or identities (#235). Rate limited
   * (#240): written when the summary changed, at most once per AVATAR_WORKER_LOG_INTERVAL_MS,
   * except that the step back to fully idle (nothing in flight or due) is always written so
   * the final state is visible. A pool that starts idle writes nothing.
   */
  let lastReportAt = Number.NEGATIVE_INFINITY
  let lastReportBusy = false
  const report = async (): Promise<void> => {
    if (config.SKILLHUB_PROFILE !== 'selfhost' && !avatarGenerationEnabled()) return
    const now = new Date()
    const [queuedGenerate, queuedDeliver] = await Promise.all([dueCount(AVATAR_LANES.generate, now), dueCount(AVATAR_LANES.deliver, now)])
    const summary = { inFlight: inFlight.generate + inFlight.deliver, generating: inFlight.generate, delivering: inFlight.deliver,
      queuedGenerate, queuedDeliver, limit: limits.total, generateLimit: limits.generate }
    const key = JSON.stringify(summary)
    const idle = summary.inFlight === 0 && queuedGenerate + queuedDeliver === 0
    if (key === lastReport || (idle && lastReport === '')) return
    const at = clock()
    if (!(idle && lastReportBusy) && at - lastReportAt < AVATAR_WORKER_LOG_INTERVAL_MS) return
    lastReport = key; lastReportAt = at; lastReportBusy = !idle
    logger.info(summary, 'Skill avatar worker')
  }
  return {
    fill,
    tick: async (): Promise<void> => { await fill(); await report().catch(() => undefined) },
    inFlight: (): Readonly<Record<AvatarLane, number>> => ({ ...inFlight }),
    stop: async (): Promise<void> => { stopped = true; await filling; await Promise.allSettled([...running]) },
  }
}

/** At most one aggregate worker line per minute (the step back to idle excepted). */
export const AVATAR_WORKER_LOG_INTERVAL_MS = 60_000

/**
 * The worker's own logger (#240): a child at `info` with `component: skill-avatar-worker`,
 * so its rate-limited aggregate line reaches the production journal while the server's
 * level stays `warn` for everything else. Its step warnings go through the same child.
 */
export function avatarWorkerLogger(logger: FastifyBaseLogger): FastifyBaseLogger {
  return logger.child({ component: 'skill-avatar-worker' }, { level: 'info' })
}

export function startAvatarWorker(logger: FastifyBaseLogger): () => Promise<void> {
  const pool = createAvatarWorkerPool(avatarWorkerLogger(logger), { total: config.SKILL_AVATAR_WORKER_CONCURRENCY, generate: config.SKILL_AVATAR_GENERATE_CONCURRENCY })
  const timer = setInterval(() => { void pool.tick() }, 5_000); timer.unref(); void pool.tick()
  return async (): Promise<void> => { clearInterval(timer); await pool.stop() }
}
