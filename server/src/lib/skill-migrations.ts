import { createHash, randomUUID } from 'node:crypto'
import type { Prisma, SkillMigration } from '@prisma/client'
import { z } from 'zod'
import { db } from '../db.js'
import { config } from '../config.js'
import { canonicalJson, avatarStyleIdSchema, avatarStyleVersionSchema, classicAvatarStyle } from './avatar-style-catalog.js'
import { avatarJobMirrorFields } from './avatar-model.js'
import { AvatarInput } from './skill-avatar-input.js'
import { getAvatarStyle } from './avatar-styles.js'
import { lockUserMutation } from './mutation-lock.js'
import { prepareCard, registerCard, grantCard } from './skill-cards.js'
import { describeSkillPackage, SKILL_PACKAGE_LIMITS } from './skill-package.js'
import { prepareCustomAvatar, sanitizeAvatarInput, CUSTOM_AVATAR_MAX_BYTES } from './skill-avatars.js'
import { uploadMedia } from './media.js'
import { prepareTopicCover, MAX_TOPIC_COVER_BYTES } from './topic-cover-assets.js'
import { imageSize } from './image-dimensions.js'
import { SkillSourceUrlSchema } from './skill-source.js'
import { requireVersion } from './version-policy.js'
import { containsSensitiveContent } from './sensitive-content.js'
import { SkillNameSchema, ImportCompatibleAgentsSchema, EnvDependenciesSchema, decodePackageWithEnv, packageEnvOutcome, userStoredPackageBytes } from '../routes/skills.js'

const hash = z.string().regex(/^[a-fA-F0-9]{64}$/).transform(value => value.toLowerCase())
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/)
export const sourceOrigin = z.string().max(2048).transform((value, ctx) => {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.origin}${path}`
  } catch { ctx.addIssue({ code: 'custom', message: 'Invalid source origin' }); return z.NEVER }
})
export const MigrationBody = z.object({
  protocolVersion: z.literal(1),
  source: z.object({ profile: z.enum(['yitan-official', 'selfhost', 'local']), origin: sourceOrigin, userId: id }).strict(),
}).strict()
export const AvatarPlan = z.object({
  id, kind: z.enum(['generated', 'custom']), styleId: avatarStyleIdSchema.optional(), styleVersion: avatarStyleVersionSchema.optional(),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']), size: z.number().int().positive().safe(), sha256: hash,
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'generated' && (!value.styleId || !value.styleVersion)) ctx.addIssue({ code: 'custom', message: 'Generated avatars need a style and version' })
  if (value.kind === 'custom' && (value.styleId || value.styleVersion)) ctx.addIssue({ code: 'custom', message: 'Custom avatars have no style' })
})
export const ItemPlan = z.object({
  sourceOrigin, sourceUserId: id, sourceSkillId: id, contentHash: hash,
  kind: z.enum(['own_skill', 'store_copy']), version: z.string().regex(/^[0-9]\.[0-9]\.[0-9]$/),
  name: SkillNameSchema, displayName: z.string().trim().min(1).max(80), description: z.string().max(500).default(''),
  targetName: SkillNameSchema.optional(), mapToSkillId: z.string().uuid().optional(),
  sourceUrl: SkillSourceUrlSchema, category: z.string().max(200).optional(),
  labels: z.array(z.string().min(1).max(200)).max(100).default([]),
  triggerScenarios: z.array(z.string().min(1).max(100)).max(8).default([]),
  compatibleAgents: ImportCompatibleAgentsSchema.default([]), envDependencies: EnvDependenciesSchema.default([]),
  packageSize: z.number().int().positive().safe(), packageSha256: hash,
  storeCopy: z.object({ listingId: id, version: z.string().min(1).max(40), state: z.enum(['current', 'outdated', 'delisted']) }).strict().optional(),
  avatars: z.array(AvatarPlan).default([]), selectedAvatarId: id.nullable().default(null),
}).strict().superRefine((value, ctx) => {
  if (value.targetName && value.mapToSkillId) ctx.addIssue({ code: 'custom', message: 'Choose a copy name or a mapping, not both' })
  if ((value.kind === 'store_copy') !== Boolean(value.storeCopy)) ctx.addIssue({ code: 'custom', message: 'Store copy provenance required only for store copies' })
  if (new Set(value.avatars.map(a => a.id)).size !== value.avatars.length || value.avatars.filter(a => a.kind === 'custom').length > 1)
    ctx.addIssue({ code: 'custom', message: 'Duplicate avatar identity or custom image' })
  if (value.selectedAvatarId && !value.avatars.some(a => a.id === value.selectedAvatarId)) ctx.addIssue({ code: 'custom', message: 'Selected avatar is missing' })
  if (containsSensitiveContent(JSON.stringify(value))) ctx.addIssue({ code: 'custom', message: 'Sensitive metadata is not accepted' })
})
export const ImportBody = z.object({
  item: ItemPlan, packageBase64: z.string().min(1).max(28_000_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.item.mapToSkillId) === Boolean(value.packageBase64)) ctx.addIssue({ code: 'custom', message: 'Package required for imports and omitted for mappings' })
})
const OperationParts = z.object({ sourceOrigin, sourceUserId: id, sourceSkillId: id, contentHash: hash }).strict()
export const AvatarUploadBody = z.object({ operation: OperationParts, avatar: AvatarPlan, dataBase64: z.string().min(1).max(7_000_000) }).strict()
export type MigrationPlan = z.infer<typeof ItemPlan>
type ImportInput = z.infer<typeof ImportBody>
export type MigrationResult = {
  operationKey: string; status: 'imported' | 'mapped' | 'failed'; targetSkillId: string | null; version: string | null;
  avatars: Array<{ id: string; status: 'imported' | 'skipped'; variantId?: string; code?: string }>;
  errors: string[];
}
export class MigrationError extends Error {
  constructor(readonly statusCode: number, readonly code: string, readonly existingSkillId?: string) { super(code) }
}
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export function operationKey(item: z.infer<typeof OperationParts>): string {
  return sha256(JSON.stringify([item.sourceOrigin, item.sourceUserId, item.sourceSkillId, item.contentHash]))
}
export function payloadHash(item: MigrationPlan): string {
  return sha256(canonicalJson(JSON.parse(JSON.stringify(item)) as Parameters<typeof canonicalJson>[0]))
}
export function assertSource(migration: SkillMigration, item: Pick<MigrationPlan, 'sourceOrigin' | 'sourceUserId'>): void {
  if (migration.sourceOrigin !== item.sourceOrigin || migration.sourceUserId !== item.sourceUserId) throw new MigrationError(400, 'MIGRATION_SOURCE_MISMATCH')
}
function avatarHash(avatar: z.infer<typeof AvatarPlan>): string {
  return sha256(canonicalJson(JSON.parse(JSON.stringify(avatar)) as Parameters<typeof canonicalJson>[0]))
}
export async function uploadMigrationAvatar(userId: string, migrationId: string, input: z.infer<typeof AvatarUploadBody>, tokenVersion: number): Promise<unknown> {
  const key = operationKey(input.operation), avatar = input.avatar, digest = avatarHash(avatar)
  assertSource(await ownedMigration(userId, migrationId), input.operation)
  const where = { migrationId_operationKey_avatarId: { migrationId, operationKey: key, avatarId: avatar.id } }
  const existing = await db.skillMigrationAvatar.findUnique({ where })
  const bytes = Buffer.from(input.dataBase64, 'base64')
  const bytesMatch = sha256(bytes) === avatar.sha256 && bytes.length === avatar.size && bytes.toString('base64') === input.dataBase64
  if (existing && (existing.payloadHash !== digest || !bytesMatch)) throw new MigrationError(409, 'MIGRATION_PAYLOAD_MISMATCH')
  const response = (code: string | null): unknown => ({ operationKey: key, id: avatar.id, status: code ? 'skipped' : 'uploaded', code })
  if (existing) return response(existing.code)
  if (!bytesMatch) throw new MigrationError(400, 'MIGRATION_HASH_MISMATCH')
  if (await db.skillMigrationItem.findUnique({ where: { migrationId_operationKey: { migrationId, operationKey: key } } })) throw new MigrationError(409, 'MIGRATION_ITEM_FINALIZED')
  try {
    const image = { mimeType: avatar.mimeType, dataBase64: input.dataBase64 }
    if (avatar.kind === 'custom') prepareCustomAvatar(image); else prepareTopicCover(image)
    if (!imageSize(bytes, avatar.mimeType)) throw new Error()
  } catch { throw new MigrationError(400, 'MIGRATION_AVATAR_INVALID') }
  const style = avatar.kind === 'generated' ? await getAvatarStyle(avatar.styleId!, avatar.styleVersion!) : null
  const code = avatar.kind === 'generated' && !style ? 'AVATAR_STYLE_UNAVAILABLE' : null
  // Media providers use their own DB connection; keep their IO outside the final transaction.
  const asset = code ? null : await uploadMedia(bytes, avatar.mimeType, `${avatar.sha256}.${avatar.mimeType === 'image/jpeg' ? 'jpg' : avatar.mimeType.split('/')[1]}`, {
    purpose: 'avatar', visibility: 'public', userId, ownerRef: `migration:${sha256(`${userId}:${migrationId}:${key}:${avatar.id}:${digest}`)}`,
  })
  if (!code && !asset?.url) throw new MigrationError(503, 'MIGRATION_MEDIA_UNAVAILABLE')
  return db.$transaction(async tx => {
    await lockUserMutation(tx, userId)
    const migration = await ownedMigration(userId, migrationId, tx)
    assertSource(migration, input.operation)
    const user = await tx.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } })
    if (!user || user.tokenVersion !== tokenVersion) throw new MigrationError(401, 'UNAUTHORIZED')
    const raced = await tx.skillMigrationAvatar.findUnique({ where })
    if (raced) {
      if (raced.payloadHash !== digest) throw new MigrationError(409, 'MIGRATION_PAYLOAD_MISMATCH')
      return response(raced.code)
    }
    if (await tx.skillMigrationItem.findUnique({ where: { migrationId_operationKey: { migrationId, operationKey: key } } })) throw new MigrationError(409, 'MIGRATION_ITEM_FINALIZED')
    await tx.skillMigrationAvatar.create({ data: { migrationId, operationKey: key, avatarId: avatar.id, payloadHash: digest, code, assetId: asset?.assetId, url: asset?.url } })
    return response(code)
  })
}
export async function ownedMigration(userId: string, migrationId: string, tx: Prisma.TransactionClient = db): Promise<SkillMigration> {
  const migration = await tx.skillMigration.findFirst({ where: { id: migrationId, targetUserId: userId } })
  if (!migration) throw new MigrationError(404, 'MIGRATION_NOT_FOUND')
  return migration
}
export function migrationLimits(): Record<string, unknown> {
  return { package: SKILL_PACKAGE_LIMITS, skills: config.SKILL_MAX_PER_USER, skillRecords: config.SKILL_MAX_PER_USER * 20,
    packageStorageBytes: config.SKILL_MAX_STORAGE_BYTES_PER_USER, customAvatarBytes: CUSTOM_AVATAR_MAX_BYTES,
    generatedAvatarBytes: MAX_TOPIC_COVER_BYTES, avatarCount: null, avatarStorageBytes: null,
    unlimited: ['avatarCount', 'avatarStorageBytes'], requestBytes: 30 * 1024 * 1024 }
}
async function usage(userId: string, tx: Prisma.TransactionClient): Promise<{ skills: number; records: number; bytes: number }> {
  const [skills, records, bytes] = await Promise.all([
    tx.skill.count({ where: { authorId: userId, deletedAt: null } }), tx.skill.count({ where: { authorId: userId } }), userStoredPackageBytes(userId, tx),
  ])
  return { skills, records, bytes }
}
function quotaReason(item: MigrationPlan, used: Awaited<ReturnType<typeof usage>>): string | null {
  if (item.packageSize > SKILL_PACKAGE_LIMITS.maxArchiveBytes) return 'PACKAGE_TOO_LARGE'
  if (used.skills >= config.SKILL_MAX_PER_USER) return 'SKILL_LIMIT'
  if (used.records >= config.SKILL_MAX_PER_USER * 20) return 'SKILL_RECORD_LIMIT'
  if (used.bytes + item.packageSize > config.SKILL_MAX_STORAGE_BYTES_PER_USER) return 'STORAGE_LIMIT'
  if (item.avatars.some(a => a.size > (a.kind === 'custom' ? CUSTOM_AVATAR_MAX_BYTES : MAX_TOPIC_COVER_BYTES))) return 'AVATAR_TOO_LARGE'
  return null
}
export async function precheckMigration(userId: string, migration: SkillMigration, items: MigrationPlan[]): Promise<unknown> {
  const used = await usage(userId, db)
  const seen = new Map<string, string>()
  const results = []
  for (const item of items) {
    assertSource(migration, item)
    const key = operationKey(item), digest = payloadHash(item)
    const existing = await db.skillMigrationItem.findUnique({ where: { migrationId_operationKey: { migrationId: migration.id, operationKey: key } } })
    const previous = existing?.payloadHash ?? seen.get(key)
    let status = 'ok', reason = 'READY', existingSkillId: string | undefined
    if (previous) { status = previous === digest ? 'skip' : 'conflict'; reason = previous === digest ? 'OPERATION_RECORDED' : 'MIGRATION_PAYLOAD_MISMATCH' }
    else {
      const target = await db.skill.findFirst({ where: { authorId: userId, deletedAt: null,
        ...(item.mapToSkillId ? { id: item.mapToSkillId } : { name: item.targetName ?? item.name }) }, select: { id: true } })
      if (item.mapToSkillId) {
        if (!target) { status = 'conflict'; reason = 'MIGRATION_TARGET_NOT_FOUND' }
      } else if (target) { status = 'conflict'; reason = 'name_exists'; existingSkillId = target.id }
      else {
        const quota = quotaReason(item, used)
        if (quota) { status = 'over_quota'; reason = quota }
        else { used.skills++; used.records++; used.bytes += item.packageSize }
      }
      seen.set(key, digest)
    }
    const avatars = []
    for (const avatar of item.mapToSkillId ? [] : item.avatars) {
      const resolvable = avatar.kind === 'custom' || await getAvatarStyle(avatar.styleId!, avatar.styleVersion!)
      avatars.push({ id: avatar.id, status: resolvable ? 'ok' : 'skipped', reason: resolvable ? 'READY' : 'AVATAR_STYLE_UNAVAILABLE' })
    }
    results.push({ operationKey: key, status, reason, ...(existingSkillId ? { existingSkillId } : {}), avatarCount: item.avatars.length, avatars })
  }
  return { items: results, limits: migrationLimits() }
}

async function importAvatars(tx: Prisma.TransactionClient, ownerId: string, skillId: string, input: ImportInput & { migrationId: string }, result: MigrationResult): Promise<void> {
  if (!input.item.avatars.length) return
  const anchorId = randomUUID()
  const avatarInput = sanitizeAvatarInput(AvatarInput.parse({ name: input.item.name, description: input.item.description.trim() || input.item.displayName, scenarios: input.item.triggerScenarios }))
  await tx.skillAvatar.create({ data: { id: anchorId, ownerId, skillId, input: avatarInput, inputFingerprint: input.item.contentHash, promptVersion: 'migration-v1', status: 'cancelled' } })
  let custom: { assetId: string; url: string } | null = null
  const variants = new Map<string, { id: string; jobId: string; url: string; assetId: string; sha256: string }>()
  let revision = 0
  const ordered = [...input.item.avatars].sort((a, b) => Number(a.id === input.item.selectedAvatarId) - Number(b.id === input.item.selectedAvatarId))
  for (const avatar of ordered) {
    const stored = await tx.skillMigrationAvatar.findUniqueOrThrow({ where: { migrationId_operationKey_avatarId: { migrationId: input.migrationId, operationKey: result.operationKey, avatarId: avatar.id } } })
    const style = avatar.kind === 'generated' ? await getAvatarStyle(avatar.styleId!, avatar.styleVersion!, tx) : null
    if (stored.code || (avatar.kind === 'generated' && !style)) { result.avatars.push({ id: avatar.id, status: 'skipped', code: 'AVATAR_STYLE_UNAVAILABLE' }); continue }
    if (!stored.assetId || !stored.url) throw new MigrationError(503, 'MIGRATION_MEDIA_UNAVAILABLE')
    const asset = { assetId: stored.assetId, url: stored.url }
    if (avatar.kind === 'custom') { custom = { assetId: asset.assetId, url: asset.url }; result.avatars.push({ id: avatar.id, status: 'imported' }); continue }
    revision++
    // Imported terminal jobs satisfy the existing Variant relation without entering the paid queue.
    const fields = { ownerId, logicalSkillId: anchorId, generationRevision: revision, styleId: avatar.styleId!, styleVersion: avatar.styleVersion!,
      inputFingerprint: input.item.contentHash, path: 'meta', promptVersion: 'migration-v1', assetId: asset.assetId, url: asset.url, imageSha256: avatar.sha256 }
    const job = await tx.avatarGenerationJob.create({ data: { ...fields, selectionRevision: 1, input: avatarInput, status: 'ready',
      falModel: style!.fal.meta.model, falParameters: style!.fal.meta.parameters, idempotencyKey: `migration:${anchorId}:${revision}` } })
    const variant = await tx.avatarVariant.create({ data: { ...fields, jobId: job.id } })
    variants.set(avatar.id, { id: variant.id, jobId: job.id, url: asset.url, assetId: asset.assetId, sha256: avatar.sha256 })
    result.avatars.push({ id: avatar.id, status: 'imported', variantId: variant.id })
  }
  const selected = input.item.selectedAvatarId ? variants.get(input.item.selectedAvatarId) : undefined
  const customSelected = Boolean(custom && input.item.avatars.some(a => a.id === input.item.selectedAvatarId && a.kind === 'custom'))
  const generated = selected ?? (customSelected ? [...variants.values()].at(-1) : undefined)
  if (input.item.selectedAvatarId && !selected && !customSelected) result.errors.push('AVATAR_SELECTION_SKIPPED')
  const display = { source: customSelected ? 'custom' : 'generated', customAssetId: custom?.assetId ?? null, customUrl: custom?.url ?? null, customUpdatedAt: custom ? new Date() : null }
  const currentJob = generated
    ? await tx.avatarGenerationJob.findUniqueOrThrow({ where: { id: generated.jobId } })
    : await tx.avatarGenerationJob.create({ data: { ownerId, logicalSkillId: anchorId, generationRevision: revision + 1, selectionRevision: 1,
      styleId: 'classic', styleVersion: 1, path: 'meta', input: avatarInput, inputFingerprint: input.item.contentHash, promptVersion: 'migration-v1',
      falModel: classicAvatarStyle.fal.meta.model, falParameters: classicAvatarStyle.fal.meta.parameters,
      idempotencyKey: `migration:${anchorId}:${revision + 1}`, status: 'cancelled' } })
  await tx.avatarSelection.create({ data: { ownerId, logicalSkillId: anchorId, ...display, variantId: generated?.id, currentJobId: currentJob.id } })
  const mirror = Object.fromEntries(avatarJobMirrorFields.map(field => [field, currentJob[field]]))
  await tx.skillAvatar.update({ where: { id: anchorId }, data: { ...mirror, ...display, currentJobId: currentJob.id } })
  await tx.skill.update({ where: { id: skillId }, data: { avatarUrl: customSelected ? custom!.url : selected?.url ?? null, avatarStatus: customSelected || selected ? 'ready' : 'pending' } })
}

export async function importMigrationItem(userId: string, migrationId: string, input: ImportInput, tokenVersion: number): Promise<{ statusCode: number; result: Prisma.JsonValue }> {
  const item = input.item, key = operationKey(item), digest = payloadHash(item)
  return db.$transaction(async tx => {
    await lockUserMutation(tx, userId)
    const migration = await ownedMigration(userId, migrationId, tx)
    const user = await tx.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } })
    if (!user || user.tokenVersion !== tokenVersion) throw new MigrationError(401, 'UNAUTHORIZED')
    assertSource(migration, item)
    const existing = await tx.skillMigrationItem.findUnique({ where: { migrationId_operationKey: { migrationId, operationKey: key } } })
    const packageBytes = Buffer.from(input.packageBase64 ?? '', 'base64')
    const bytesMatch = Boolean(item.mapToSkillId) || (sha256(packageBytes) === item.packageSha256 && packageBytes.toString('base64') === input.packageBase64)
    if (existing) {
      if (existing.payloadHash !== digest || !bytesMatch) throw new MigrationError(409, 'MIGRATION_PAYLOAD_MISMATCH')
      return { statusCode: existing.statusCode, result: existing.result }
    }
    const result: MigrationResult = { operationKey: key, status: 'failed', targetSkillId: null, version: null, avatars: [], errors: [] }
    const save = async (statusCode: number): Promise<{ statusCode: number; result: Prisma.JsonValue }> => {
      const saved = await tx.skillMigrationItem.create({ data: { migrationId, operationKey: key, payloadHash: digest, statusCode, result } })
      return { statusCode, result: saved.result }
    }
    const name = item.targetName ?? item.name
    const target = await tx.skill.findFirst({ where: { authorId: userId, deletedAt: null,
      ...(item.mapToSkillId ? { id: item.mapToSkillId } : { name }) }, select: { id: true, currentVersion: true } })
    if (item.mapToSkillId) {
      if (!target) throw new MigrationError(404, 'MIGRATION_TARGET_NOT_FOUND')
      result.status = 'mapped'; result.targetSkillId = target.id; result.version = target.currentVersion
      return save(200)
    }
    if (target) throw new MigrationError(409, 'MIGRATION_NAME_CONFLICT', target.id)
    if (!bytesMatch) throw new MigrationError(400, 'MIGRATION_HASH_MISMATCH')
    for (const avatar of item.avatars) {
      const uploaded = await tx.skillMigrationAvatar.findUnique({ where: { migrationId_operationKey_avatarId: { migrationId, operationKey: key, avatarId: avatar.id } } })
      if (!uploaded) throw new MigrationError(409, 'MIGRATION_AVATAR_NOT_UPLOADED')
      if (uploaded.payloadHash !== avatarHash(avatar)) throw new MigrationError(409, 'MIGRATION_PAYLOAD_MISMATCH')
    }
    let validated: ReturnType<typeof decodePackageWithEnv>, described: ReturnType<typeof describeSkillPackage>
    try {
      validated = decodePackageWithEnv(input.packageBase64, item.packageSha256)
      described = describeSkillPackage(validated.packageFields.packageData!)
      if (described.contentHash !== item.contentHash || validated.packageFields.packageSize !== item.packageSize) throw new Error()
    } catch { result.errors.push('MIGRATION_CONTENT_INVALID'); return save(400) }
    const quota = quotaReason(item, await usage(userId, tx))
    if (quota) { result.errors.push(quota); return save(413) }
    const env = packageEnvOutcome(validated.env, described.skillMd, item.envDependencies, () => [])
    if (!env.ok) { result.errors.push('MIGRATION_ENV_INVALID'); return save(400) }
    const card = await prepareCard(validated.packageFields.packageData!)
    await registerCard(tx, card, userId)
    const skillId = randomUUID(), versionId = randomUUID()
    const labels = item.kind === 'store_copy' ? [...new Set([...item.labels, '官方商店个人副本'])] : item.labels
    const profile = { displayName: item.displayName, description: item.description, sourceUrl: item.sourceUrl, category: item.category, labels,
      triggerScenarios: item.triggerScenarios, compatibleAgents: item.compatibleAgents, envDependencies: env.envDependencies, sourceContent: described.skillMd }
    await tx.skill.create({ data: { ...profile, id: skillId, name, authorId: userId, currentVersion: item.version, versionHighWater: requireVersion(item.version),
      migrationSource: { migrationId, profile: migration.sourceProfile, origin: item.sourceOrigin, userId: item.sourceUserId, skillId: item.sourceSkillId, version: item.version, contentHash: item.contentHash },
      ...(item.storeCopy ? { storeCopy: { ...item.storeCopy, label: `来自官方商店 v${item.storeCopy.version}（${item.storeCopy.state}），个人副本，不可发布` } } : {}),
      versions: { create: { ...profile, id: versionId, skillName: name, version: item.version, profileSnapshotVersion: 1,
        ...validated.packageFields, cardSha256: card.sha256, detectedUndeclared: env.detectedUndeclared ?? undefined } } } })
    await tx.skill.update({ where: { id: skillId }, data: { importVersionId: versionId } })
    await grantCard(tx, userId, card.sha256, item.kind === 'store_copy' ? 'upload' : 'authored', `skill:${skillId}`)
    await importAvatars(tx, userId, skillId, { ...input, migrationId }, result)
    result.status = 'imported'; result.targetSkillId = skillId; result.version = item.version
    return save(201)
  }, { maxWait: 10_000, timeout: 120_000 })
}
