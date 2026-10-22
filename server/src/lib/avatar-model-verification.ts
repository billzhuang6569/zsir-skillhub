import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Prisma, type SkillAvatar, type AvatarGenerationJob, type AvatarVariant, type AvatarSelection,
  type SkillAvatarAlias, type SkillAvatarGenerationAttempt, type MarketplaceListing, type Skill, type AvatarStyleVersion } from '@prisma/client'
import { db } from '../db.js'
import { config } from '../config.js'
import { classicAvatarStyle, canonicalJson } from './avatar-style-catalog.js'
import { avatarJobMirrorFields, avatarPromptHash, legacyAvatarDisplay } from './avatar-model.js'
import { publicImageUrl } from './media.js'
import { cachedStyle } from './avatar-styles.js'
import { variantsMode, selectionAvatar } from './avatar-selection.js'

export type AvatarModelSnapshot = {
  anchors: SkillAvatar[]; jobs: AvatarGenerationJob[]; variants: AvatarVariant[]; selections: AvatarSelection[]
  aliases: SkillAvatarAlias[]; attempts: SkillAvatarGenerationAttempt[]; listings: MarketplaceListing[]
  skills: Array<Pick<Skill, 'id' | 'authorId' | 'deletedAt'> & Partial<Pick<Skill, 'avatarUrl' | 'avatarStatus'>>>; styles: AvatarStyleVersion[]
}

async function loadSnapshot(tx: Prisma.TransactionClient): Promise<AvatarModelSnapshot> {
  const [anchors, jobs, variants, selections, aliases, attempts, listings, skills, styles] = await Promise.all([
    tx.skillAvatar.findMany({ orderBy: { id: 'asc' } }), tx.avatarGenerationJob.findMany({ orderBy: { id: 'asc' } }),
    tx.avatarVariant.findMany({ orderBy: { id: 'asc' } }), tx.avatarSelection.findMany({ orderBy: [{ ownerId: 'asc' }, { logicalSkillId: 'asc' }] }),
    tx.skillAvatarAlias.findMany({ orderBy: [{ ownerId: 'asc' }, { aliasLocalId: 'asc' }] }),
    tx.skillAvatarGenerationAttempt.findMany({ orderBy: { id: 'asc' } }),
    tx.marketplaceListing.findMany({ orderBy: { skillId: 'asc' } }),
    tx.skill.findMany({ select: { id: true, authorId: true, deletedAt: true, ...(!variantsMode() ? { avatarUrl: true, avatarStatus: true } : {}) }, orderBy: { id: 'asc' } }),
    tx.avatarStyleVersion.findMany(),
  ])
  return { anchors, jobs, variants, selections, aliases, attempts, listings, skills, styles }
}
type Difference = { category: string; anchorId?: string; ownerId?: string; field?: string }
type Verification = { counts: Record<string, number>; digests: Record<string, string> }

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Pure comparison so PG and unit fixtures exercise the same checks as the operator command. */
export function inspectAvatarModel(data: AvatarModelSnapshot, mode: 'legacy' | 'variants' = 'legacy'): { summary: Verification; differences: Difference[] } {
  const counts: Record<string, number> = { anchors: data.anchors.length, jobs: data.jobs.length, variants: data.variants.length,
    selections: data.selections.length, aliases: data.aliases.length, attempts: data.attempts.length, listings: data.listings.length, mismatches: 0 }
  const differences: Difference[] = []
  const bad = (category: string, anchorId?: string, ownerId?: string, field?: string): void => {
    counts.mismatches += 1; counts[`mismatch.${category}`] = (counts[`mismatch.${category}`] ?? 0) + 1
    differences.push({ category, anchorId, ownerId, field })
  }
  const anchors = new Map(data.anchors.map(row => [row.id, row]))
  const jobs = new Map(data.jobs.map(row => [row.id, row]))
  const variants = new Map(data.variants.map(row => [row.id, row]))
  const selections = new Map(data.selections.map(row => [row.logicalSkillId, row]))
  const skills = new Map(data.skills.map(row => [row.id, row]))
  const classic = data.styles.find(row => row.styleId === 'classic' && row.styleVersion === 1)
  if (!classic || classic.content !== canonicalJson(classicAvatarStyle) || classic.contentSha256 !== createHash('sha256').update(classic.content).digest('hex')) bad('style')
  const oldDtos: unknown[] = [], newDtos: unknown[] = []
  for (const avatar of data.anchors) {
    const group = `anchor.${avatar.status}.${avatar.source}.${avatar.skillId ? skills.get(avatar.skillId)?.deletedAt ? 'deleted' : 'cloud' : 'local'}`
    counts[group] = (counts[group] ?? 0) + 1
    if (avatar.skillId && skills.get(avatar.skillId)?.authorId !== avatar.ownerId) bad('identity', avatar.id, avatar.ownerId)
    if (avatar.status !== 'superseded' && !avatar.skillId && !avatar.localSkillId) bad('identity', avatar.id, avatar.ownerId)
    const job = avatar.currentJobId ? jobs.get(avatar.currentJobId) : undefined
    if (!job) bad('jobCoverage', avatar.id, avatar.ownerId)
    else {
      if (job.ownerId !== avatar.ownerId || job.logicalSkillId !== avatar.id) bad('jobIdentity', avatar.id, avatar.ownerId)
      for (const field of avatarJobMirrorFields) if (!isDeepStrictEqual(job[field], avatar[field])) bad('mirror', avatar.id, avatar.ownerId, field)
    }
    const selection = selections.get(avatar.id)
    if (avatar.status === 'superseded') { if (selection) bad('retiredSelection', avatar.id, avatar.ownerId); continue }
    if (!selection) { bad('selectionCoverage', avatar.id, avatar.ownerId); continue }
    const selectedJob = selection.currentJobId ? jobs.get(selection.currentJobId) : undefined
    if (selection.ownerId !== avatar.ownerId || (selection.currentJobId && (!selectedJob || selectedJob.ownerId !== avatar.ownerId || selectedJob.logicalSkillId !== avatar.id))
      || (mode === 'legacy' && selection.currentJobId !== avatar.currentJobId)) bad('selectionIdentity', avatar.id, avatar.ownerId)
    for (const field of ['source', 'customAssetId', 'customUrl', 'customUpdatedAt'] as const) {
      if (!isDeepStrictEqual(selection[field], avatar[field])) bad('selectionMirror', avatar.id, avatar.ownerId, field)
    }
    const variant = selection.variantId ? variants.get(selection.variantId) : undefined
    if (selection.variantId && (!variant || variant.ownerId !== avatar.ownerId || variant.logicalSkillId !== avatar.id)) bad('selectionVariant', avatar.id, avatar.ownerId)
    if (mode === 'legacy' && avatar.status === 'ready' && (!variant || variant.jobId !== avatar.currentJobId)) bad('readyCoverage', avatar.id, avatar.ownerId)
    if (mode === 'variants' && selectedJob?.status === 'ready' && selection.source === 'generated'
      && selection.revision === selectedJob.selectionRevision && variant?.jobId !== selectedJob.id) bad('readyCoverage', avatar.id, avatar.ownerId)
    const oldDto = legacyAvatarDisplay(avatar)
    const newDto = mode === 'variants' ? selectionAvatar({ source: selection.source, customUrl: selection.customUrl,
      revision: selection.revision, variant: variant ? { url: variant.url } : null, currentJob: selectedJob ? { status: selectedJob.status } : null })
      : legacyAvatarDisplay({ source: selection.source, customUrl: selection.customUrl,
        status: variant ? 'ready' : selectedJob?.status ?? 'none', url: variant?.url ?? null })
    oldDtos.push([avatar.ownerId, avatar.id, avatar.skillId, avatar.localSkillId, oldDto])
    newDtos.push([avatar.ownerId, avatar.id, avatar.skillId, avatar.localSkillId, newDto])
    if (mode === 'legacy' && !isDeepStrictEqual(oldDto, newDto)) bad('display', avatar.id, avatar.ownerId)
    if (mode === 'legacy' && avatar.skillId) {
      const skill = skills.get(avatar.skillId)
      if (skill && !skill.deletedAt && (skill.avatarUrl !== oldDto.avatarUrl || skill.avatarStatus !== oldDto.avatarStatus)) bad('skillDisplay', avatar.id, avatar.ownerId)
    }
  }
  const requests = new Set<string>(), active = new Set<string>()
  for (const job of data.jobs) {
    if (anchors.get(job.logicalSkillId)?.ownerId !== job.ownerId) bad('jobIdentity', job.logicalSkillId, job.ownerId)
    if (job.promptSha256 !== avatarPromptHash(job.prompt)) bad('promptHash', job.logicalSkillId, job.ownerId)
    if (job.imageData && createHash('sha256').update(job.imageData).digest('hex') !== job.imageSha256) bad('imageHash', job.logicalSkillId, job.ownerId)
    const row = data.styles.find(style => style.styleId === job.styleId && style.styleVersion === job.styleVersion)
    const style = row ? cachedStyle(row) : null
    const path = job.path === 'direct' ? 'direct' : 'meta'
    if (!style || (job.submittedAt && !job.path) || job.falModel !== style.fal[path].model
      || !isDeepStrictEqual(job.falParameters, style.fal[path].parameters)
      || (mode === 'legacy' && !job.idempotencyKey.startsWith('migration:') && (job.styleId !== 'classic' || job.styleVersion !== 1 || job.path !== 'meta'))) bad('jobStyle', job.logicalSkillId, job.ownerId)
    if (job.requestId) { if (requests.has(job.requestId)) bad('requestUnique', job.logicalSkillId, job.ownerId); requests.add(job.requestId) }
    if (['queued','drafting','prompting','submitting','awaiting','transferring','needs_review'].includes(job.status)) {
      const key = JSON.stringify([job.ownerId, job.logicalSkillId, ...(mode === 'variants' ? [job.styleId] : [])])
      if (active.has(key)) bad('activeUnique', job.logicalSkillId, job.ownerId)
      active.add(key)
    }
    if (job.status === 'ready' && !data.variants.some(v => v.jobId === job.id)) bad('variantCoverage', job.logicalSkillId, job.ownerId)
  }
  for (const variant of data.variants) {
    const job = jobs.get(variant.jobId)
    if (!job || job.status !== 'ready') { bad('variantJob', variant.logicalSkillId, variant.ownerId); continue }
    for (const field of ['ownerId','logicalSkillId','generationRevision','styleId','styleVersion','path','inputFingerprint','promptVersion','prompt','promptSha256','assetId','url','imageSha256'] as const) {
      if (!isDeepStrictEqual(variant[field], job[field])) bad('variantResult', variant.logicalSkillId, variant.ownerId, field)
    }
  }
  for (const selection of data.selections) if (anchors.get(selection.logicalSkillId)?.ownerId !== selection.ownerId) bad('selectionIdentity', selection.logicalSkillId, selection.ownerId)
  for (const alias of data.aliases) {
    if (anchors.get(alias.avatarId)?.ownerId !== alias.ownerId) bad('aliasOwner', alias.avatarId, alias.ownerId)
    if (data.anchors.some(a => a.ownerId === alias.ownerId && a.localSkillId === alias.aliasLocalId && a.id !== alias.avatarId && a.status !== 'superseded')) bad('aliasConflict', alias.avatarId, alias.ownerId)
  }
  const linkedAttempts = new Set<string>(), baselines = new Set<string>()
  for (const attempt of data.attempts) {
    if (!anchors.has(attempt.avatarId)) bad('ledgerAnchor', attempt.avatarId)
    if (attempt.kind === 'baseline') { if (baselines.has(attempt.avatarId)) bad('ledgerBaseline', attempt.avatarId); baselines.add(attempt.avatarId) }
    if (attempt.jobId) {
      const job = jobs.get(attempt.jobId)
      if (!job || job.logicalSkillId !== attempt.avatarId || job.queuedAt?.getTime() !== attempt.createdAt.getTime() || linkedAttempts.has(attempt.jobId)) bad('ledgerJob', attempt.avatarId)
      linkedAttempts.add(attempt.jobId)
    }
    if (!attempt.releasedAt) { const key = `quota.${attempt.day.toISOString().slice(0,10)}`; counts[key] = (counts[key] ?? 0) + 1 }
  }
  for (const job of data.jobs) {
    if (job.queuedAt && job.idempotencyKey.startsWith('avatar:') && !linkedAttempts.has(job.id)) bad('ledgerMissing', job.logicalSkillId, job.ownerId)
    if (job.status === 'queued' && !job.leaseToken && !job.submittedAt && !job.requestId && !data.attempts.some(t => t.jobId === job.id && !t.releasedAt)) bad('ledgerRefund', job.logicalSkillId, job.ownerId)
  }
  for (const listing of data.listings) if (!listing.avatarSnapshotAt || !listing.avatarStatus || !listing.avatarSource) bad('listingSnapshot', listing.skillId)
  if (mode === 'legacy') for (const skill of data.skills) if (skill.avatarUrl && !data.anchors.some(a => a.skillId === skill.id) && !data.listings.some(l => l.skillId === skill.id && l.avatarUrl === skill.avatarUrl)) bad('unmappedSkill', skill.id, skill.authorId)
  return { summary: { counts, digests: {
    identities: digest(data.anchors.map(a => [a.ownerId,a.id,a.skillId,a.localSkillId])), aliases: digest(data.aliases),
    ledger: digest(data.attempts.map(({ jobId: _jobId, ...legacy }) => legacy)), ledgerLinks: digest(data.attempts.map(t => [t.id,t.jobId])),
    legacyDisplay: digest(oldDtos), modelDisplay: digest(newDtos),
    listings: digest(data.listings.map(l => [l.skillId,l.avatarUrl,l.avatarStatus,l.avatarSource,l.avatarSnapshotAt,l.avatarUpdatedById])),
  } }, differences }
}

export async function readAvatarImageHash(value: string): Promise<string> {
  const trusted = publicImageUrl(value)
  const url = new URL(trusted, config.PUBLIC_BASE_URL)
  if (config.SKILLHUB_PROFILE === 'selfhost' && url.origin !== new URL(config.PUBLIC_BASE_URL).origin) throw new Error('AVATAR_IMAGE_UNTRUSTED')
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('AVATAR_IMAGE_UNAVAILABLE')
  const reader = response.body.getReader(), hash = createHash('sha256')
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 10 * 1024 * 1024) throw new Error('AVATAR_IMAGE_TOO_LARGE')
      hash.update(part.value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  if (!size) throw new Error('AVATAR_IMAGE_EMPTY')
  return hash.digest('hex')
}

export async function verifyAvatarModel(options: { images?: boolean; reportPath?: string } = {}): Promise<Verification> {
  const data = await db.$transaction(loadSnapshot, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  const { summary, differences } = inspectAvatarModel(data, variantsMode() ? 'variants' : 'legacy')
  const images: Array<{ url: string; hash: string | null }> = []
  if (options.images) {
    const refs = new Map<string, Set<string>>()
    const add = (url: string | null, hash: string | null = null): void => {
      if (!url) return
      const known = refs.get(url) ?? new Set<string>(); if (hash) known.add(hash); refs.set(url, known)
    }
    for (const row of [...data.anchors, ...data.jobs, ...data.variants]) add(row.url, row.imageSha256)
    for (const row of [...data.anchors, ...data.selections]) add(row.customUrl)
    for (const row of data.listings) add(row.avatarUrl)
    for (const [url, expected] of [...refs].sort(([a],[b]) => a.localeCompare(b))) {
      let hash: string | null = null
      let category: string | null = null
      try { hash = await readAvatarImageHash(url); if ([...expected].some(value => value !== hash)) category = 'permanentImageHash' }
      catch { category = 'permanentImageRead' }
      images.push({ url, hash })
      if (!expected.size) summary.counts.imagesWithoutStoredHash = (summary.counts.imagesWithoutStoredHash ?? 0) + 1
      if (category) { summary.counts.mismatches += 1; summary.counts[`mismatch.${category}`] = (summary.counts[`mismatch.${category}`] ?? 0) + 1; differences.push({ category, field: url }) }
    }
    summary.counts.images = refs.size
    summary.digests.images = digest(images)
  }
  if (options.reportPath) {
    if (!isAbsolute(options.reportPath)) throw new Error('AVATAR_REPORT_REQUIRES_ABSOLUTE_PATH')
    // Exclusive creation rejects existing files and symlinks; no sensitive details go to stdout.
    const file = await open(options.reportPath, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify({ ...summary, differences, images }, null, 2)); await file.sync() }
    finally { await file.close() }
  }
  return summary
}

export async function assertAvatarReadModeAvailable(mode: 'legacy' | 'variants'): Promise<void> {
  if (mode !== 'variants') return
  let result: Verification
  try { result = await verifyAvatarModel() }
  catch { throw new Error('Avatar model database verification unavailable') }
  if (result.counts.mismatches) throw new Error(`Avatar model verification failed: ${result.counts.mismatches} mismatches`)
}
