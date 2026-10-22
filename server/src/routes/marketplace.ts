import { createHash, randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import { AttemptLimiter } from '../lib/attempt-limiter.js'
import { lockSkillMutation, lockUserMutation } from '../lib/mutation-lock.js'
import { loadVersionPackage, prepareCard, registerCard, grantCard, requireCardAuthorship } from '../lib/skill-cards.js'
import { loadHotSkillIds, marketplaceBadges } from '../lib/marketplace-badges.js'
import { listingTrend, rankRising, recordListingMetric, trendCounts, type ListingTrend } from '../lib/marketplace-trends.js'
import { containsSensitiveContent } from '../lib/sensitive-content.js'
import { SkillSourceUrlSchema } from '../lib/skill-source.js'
import {
  inspectPublicSkillPackage,
  SKILL_PACKAGE_REVIEW_LIMITS,
  SkillPackageValidationError,
  validatePublicSkillPackage,
} from '../lib/skill-package.js'
import { authMiddleware } from '../middleware/auth.js'
import { catalogAuthMiddleware, catalogTokenCurrent } from '../middleware/catalog-auth.js'
import { configureAgentRoutes, requireAgentScope, auditAgentMutation, auditAdminMutation, type AdminAgentAccess } from '../middleware/admin-agent.js'
import { skillPackageContentDisposition, SkillProfileSchema, SkillNameSchema, EnvDependenciesSchema, decodePackageWithEnv, packageEnvOutcome, userStoredPackageBytes } from './skills.js'
import { allocateVersion, skillHighWater, requireVersion } from '../lib/version-policy.js'
import { queueCloudAvatar } from '../lib/skill-avatars.js'
import { variantsMode, listingAvatar, readOwnerSelection, selectionAvatar, selectionDisplaySelect } from '../lib/avatar-selection.js'

const MarketplaceAgentSchema = z.enum([
  'claude', 'codex', 'agent-skills', 'workbuddy', 'doubao', 'opencode', 'openclaw', 'gemini', 'trae',
])

export const MARKETPLACE_ABUSE_LIMITS = {
  publicReadsPerMinute: 120,
  submissionWritesPerHour: 12,
  maxSubmissionHistoryPerSkill: 100,
  downloadCountWindowMs: 24 * 60 * 60 * 1_000,
  maxCatalogPage: 200,
} as const

const MarketplaceListQuery = z.object({
  featured: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  query: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  label: z.string().trim().max(80).optional(),
  agent: MarketplaceAgentSchema.optional(),
  sort: z.enum(['latest', 'downloads', 'popular', 'users', 'rising']).default('latest'),
  // 「需配置 API Key」(#251): required = the approved snapshot has at least one required key;
  // none = it has no required key (optional keys alone do not count).
  apiKey: z.enum(['none', 'required']).optional(),
  page: z.coerce.number().int().min(1).max(MARKETPLACE_ABUSE_LIMITS.maxCatalogPage).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(24),
})

const SubmitMarketplaceBody = z.object({
  versionId: z.string().uuid(),
  note: z.string().trim().max(1_000).optional(),
})

const AdminPublishBody = z.object({
  clientOperationId: z.string().uuid(),
  name: SkillNameSchema,
  version: z.string().regex(/^[0-9]\.[0-9]\.[0-9]$/).default('0.1.0'),
  profile: SkillProfileSchema.extend({ sourceUrl: SkillSourceUrlSchema }),
  compatibleAgents: z.array(MarketplaceAgentSchema).max(9),
  envDependencies: EnvDependenciesSchema,
  packageBase64: z.string().min(4).max(28_000_000),
  packageSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

const CatalogSubmissionBody = AdminPublishBody.extend({
  skillMd: z.string().trim().min(1).max(100_000),
  sourceOrigin: z.string().url().max(2048).refine(value => {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  }).transform(value => new URL(value).href.replace(/\/$/, '')),
  sourceSkillId: z.string().trim().min(1).max(255),
  note: z.string().trim().max(1000).optional(),
}).strict()

const ApproveMarketplaceBody = z.object({
  expectedVersionId: z.string().uuid().optional(),
  expectedPackageSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  note: z.string().trim().max(2_000).optional(),
})

const ReviewBinding = z.object({
  expectedVersionId: z.string().uuid(),
  expectedPackageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedStatus: z.enum(['submitted', 'under_review']),
})

function matchesReviewBinding(submission: { status: string; versionId: string; version: { packageSha256: string | null } }, binding: z.infer<typeof ReviewBinding>): boolean {
  return submission.status === binding.expectedStatus && submission.versionId === binding.expectedVersionId && submission.version.packageSha256 === binding.expectedPackageSha256
}

const ReviewNoteSchema = z.string().trim().min(1).max(2_000)

const RejectMarketplaceBody = z.object({
  reviewNote: ReviewNoteSchema.optional(),
  // Compatibility alias for the first desktop contract. Responses and stored
  // reviewer feedback use the canonical reviewNote field everywhere.
  reason: ReviewNoteSchema.optional(),
}).refine((value) => value.reviewNote !== undefined || value.reason !== undefined, {
  message: 'reviewNote is required',
})

const AdminQueueQuery = z.object({
  search: z.string().trim().max(200).optional(),
  category: z.string().trim().max(100).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  status: z.enum(['all', 'submitted', 'under_review', 'approved', 'rejected', 'withdrawn']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

const versionPublicSelect = {
  id: true,
  version: true,
  changelog: true,
  packageSha256: true,
  packageSize: true,
  createdAt: true,
} satisfies Prisma.SkillVersionSelect

const submissionInclude = {
  version: { select: versionPublicSelect },
  skill: { select: { id: true, avatarUrl: !variantsMode(), avatarStatus: !variantsMode() } },
} satisfies Prisma.MarketplaceSubmissionInclude

const listingInclude = {
  category: true,
  submission: true,
  version: { select: versionPublicSelect },
  skill: {
    select: {
      deletedAt: true,
      avatarUrl: !variantsMode(),
      avatarStatus: !variantsMode(),
      author: { select: { id: true, displayName: true, avatarUrl: true } },
    },
  },
} satisfies Prisma.MarketplaceListingInclude

type SubmissionRecord = Prisma.MarketplaceSubmissionGetPayload<{
  include: typeof submissionInclude
}>

/** Admin queue rows also carry the Skill's current admin unlisting, so reviewers see that approval re-lists it. */
const adminSubmissionInclude = {
  ...submissionInclude,
  // Reviewers also see the Server's package re-check (#251); the public select never carries it.
  version: { select: { ...versionPublicSelect, detectedUndeclared: true } },
  skill: { select: { id: true, avatarUrl: !variantsMode(), avatarStatus: !variantsMode(),
    avatar: { select: { selection: { select: selectionDisplaySelect } } },
    marketplaceListing: { select: { withdrawnAt: true, withdrawnBy: true, withdrawnReason: true, avatarUrl: true, avatarStatus: true, avatarSource: true } } } },
  submittedBy: { select: { id: true, displayName: true, avatarUrl: true } },
} satisfies Prisma.MarketplaceSubmissionInclude

type AdminSubmissionRecord = Prisma.MarketplaceSubmissionGetPayload<{
  include: typeof adminSubmissionInclude
}>

type ListingRecord = Prisma.MarketplaceListingGetPayload<{
  include: typeof listingInclude
}>

type PackageVersion = {
  id: string
  version: string
  cardSha256?: string | null
  packageData: Buffer | null
  packageSha256: string | null
  packageSize?: number | null
}

class MarketplacePackageReviewLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarketplacePackageReviewLimitError'
  }
}

function isPackageReviewLimitError(error: unknown): boolean {
  return error instanceof MarketplacePackageReviewLimitError
    || (error instanceof SkillPackageValidationError
      && error.message === 'Skill package readable text exceeds review limit')
}

const activeSubmissionStatuses = ['submitted', 'under_review'] as const

function submissionDto(submission: SubmissionRecord) {
  return {
    id: submission.id,
    skillId: submission.skillId,
    version: submission.version,
    status: submission.status,
    submitterNote: submission.submitterNote,
    reviewNote: submission.reviewNote,
    submittedAt: submission.submittedAt,
    reviewStartedAt: submission.reviewStartedAt,
    reviewedAt: submission.reviewedAt,
    withdrawnAt: submission.withdrawnAt,
  }
}

function marketplaceItem(
  listing: ListingRecord,
  includeSource = false,
  hotSkillIds: ReadonlySet<string> = new Set(),
  trend?: ListingTrend,
) {
  const submission = listing.submission
  return {
    id: listing.skillId,
    listingId: listing.skillId,
    name: submission.skillName,
    displayName: submission.displayName,
    description: submission.description,
    sourceUrl: submission.sourceUrl,
    ...listingAvatar(listing, listing.skill),
    category: listing.category?.name ?? submission.category,
    categorySlug: listing.category?.slug ?? null,
    labels: submission.labels,
    featured: listing.featured,
    original: listing.original,
    editorialLabels: listing.editorialLabels,
    triggerScenarios: submission.triggerScenarios,
    compatibleAgents: submission.compatibleAgents,
    envDependencies: submission.envDependencies,
    currentVersion: listing.version.version,
    author: listing.skill.author,
    version: listing.version,
    downloadCount: listing.downloadCount,
    installCount: listing.installClickCount,
    userCount: listing.activeUserCount,
    publishedAt: listing.publishedAt,
    firstPublishedAt: listing.firstPublishedAt,
    ...(variantsMode() ? { updatedAt: listing.updatedAt } : {}),
    badges: marketplaceBadges(listing, hotSkillIds),
    ...(trend ? { trend } : {}),
    ...(includeSource ? { skillMd: submission.sourceContent } : {}),
  }
}

function adminSubmissionDto(submission: AdminSubmissionRecord) {
  const listing = submission.skill?.marketplaceListing
  const detected = submission.version.detectedUndeclared
  return {
    ...submissionDto(submission),
    detectedUndeclared: Array.isArray(detected) ? detected.filter((key): key is string => typeof key === 'string') : [],
    adminWithdrawal: listing?.withdrawnAt && listing.withdrawnBy === 'admin'
      ? { withdrawnAt: listing.withdrawnAt, reason: listing.withdrawnReason }
      : null,
    author: submission.submittedBy,
    skill: {
      id: submission.skillId,
      name: submission.skillName,
      displayName: submission.displayName,
      description: submission.description,
      sourceUrl: submission.sourceUrl,
      ...(variantsMode()
        ? activeSubmissionStatuses.includes(submission.status as typeof activeSubmissionStatuses[number])
          ? { ...selectionAvatar(submission.skill.avatar?.selection), avatarLivePreview: true }
          : listingAvatar(listing ?? { avatarUrl: null, avatarStatus: 'none', avatarSource: 'generated' }, {})
        : { avatarUrl: submission.skill?.avatarUrl ?? null, avatarStatus: submission.skill?.avatarStatus ?? 'none' }),
      category: submission.category,
      labels: submission.labels,
      compatibleAgents: submission.compatibleAgents,
      currentVersion: submission.version.version,
    },
    // Kept as additive fields for review tooling that consumes the immutable
    // submission snapshot directly. Desktop uses the friendlier aliases above.
    submittedBy: submission.submittedBy,
    snapshot: {
      name: submission.skillName,
      displayName: submission.displayName,
      description: submission.description,
      sourceUrl: submission.sourceUrl,
      category: submission.category,
      labels: submission.labels,
      triggerScenarios: submission.triggerScenarios,
      compatibleAgents: submission.compatibleAgents,
      envDependencies: submission.envDependencies,
      skillMd: submission.sourceContent,
    },
  }
}

function verifiedPackageBytes(version: PackageVersion): { packageData: Buffer; packageSha256: string } {
  if (!version.packageData) {
    throw new Error('The approved Skill version has no installable package')
  }
  const packageSha256 = createHash('sha256').update(version.packageData).digest('hex')
  if (version.packageSha256 && version.packageSha256 !== packageSha256) {
    throw new Error('Stored checksum does not match package bytes')
  }
  if (version.packageSize !== undefined && version.packageSize !== null
    && version.packageSize !== version.packageData.length) {
    throw new Error('Stored package size does not match package bytes')
  }
  return { packageData: version.packageData, packageSha256 }
}

async function marketplaceAdminMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (request.user.marketplaceRole !== 'admin') {
    return reply.forbidden('Marketplace administrator access required')
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function jsonArraySnapshot(value: Prisma.JsonValue): Prisma.InputJsonValue {
  return Array.isArray(value) ? value as Prisma.InputJsonValue : []
}

function containsSensitivePublicValue(value: unknown): boolean {
  if (typeof value === 'string') return containsSensitiveContent(value)
  if (Array.isArray(value)) return value.some(containsSensitivePublicValue)
  if (!value || typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).some(containsSensitivePublicValue)
}

function containsSensitivePublicMetadata(value: {
  skillName: string | null
  displayName: string | null
  description: string | null
  category: string | null
  labels: unknown
  triggerScenarios: unknown
  compatibleAgents: unknown
  envDependencies: unknown
  sourceContent: string | null
  changelog: string | null
  sourceUrl?: string | null
}): boolean {
  return containsSensitivePublicValue(value)
}

function completeProfileSnapshot(version: {
  profileSnapshotVersion: number | null
  skillName: string | null
  displayName: string | null
  labels: unknown
  triggerScenarios: unknown
  compatibleAgents: unknown
  envDependencies: unknown
  sourceContent: string | null
}): boolean {
  return version.profileSnapshotVersion === 1
    && Boolean(version.skillName)
    && Boolean(version.displayName)
    && Array.isArray(version.labels)
    && Array.isArray(version.triggerScenarios)
    && Array.isArray(version.compatibleAgents)
    && Array.isArray(version.envDependencies)
    && Boolean(version.sourceContent)
}

/**
 * The author takes the Skill off the store. A listing an admin already unlisted is re-attributed to
 * the author too (and its updatedAt advances), so an admin can no longer restore it: an author
 * withdrawal is only undone by a new reviewed submission.
 */
export async function markListingWithdrawnByAuthor(transaction: Prisma.TransactionClient, skillId: string, now: Date): Promise<void> {
  await transaction.marketplaceListing.updateMany({
    where: { skillId, withdrawnAt: null },
    data: { withdrawnAt: now, withdrawnBy: 'author', withdrawnReason: null },
  })
  await transaction.marketplaceListing.updateMany({
    where: { skillId, withdrawnAt: { not: null }, withdrawnBy: 'admin' },
    data: { withdrawnBy: 'author', withdrawnReason: null },
  })
}

async function publishApprovedListing(transaction: Prisma.TransactionClient, submission: { id: string; skillId: string; versionId: string }, now: Date, preserveAvatar = false): Promise<void> {
  const skill = await transaction.skill.findUniqueOrThrow({ where: { id: submission.skillId }, select: { authorId: true, avatarUrl: !variantsMode(), avatarStatus: !variantsMode() } })
  const display = variantsMode() ? selectionAvatar(await readOwnerSelection(transaction, submission.skillId)) : null
  const avatar = display
    ? { ...(display.avatarStatus === 'ready' ? display : { avatarUrl: null, avatarStatus: 'none', avatarSource: 'generated' }), avatarSnapshotAt: now, avatarUpdatedById: skill.authorId }
    : { avatarUrl: skill.avatarUrl, avatarStatus: skill.avatarStatus, avatarSource: 'legacy', avatarSnapshotAt: now }
  await transaction.marketplaceListing.upsert({
    where: { skillId: submission.skillId },
    create: {
      skillId: submission.skillId,
      ...avatar,
      submissionId: submission.id,
      versionId: submission.versionId,
      publishedAt: now,
      firstPublishedAt: now,
    },
    // New versions and re-listing retain the first publication used by store badges.
    update: {
      submissionId: submission.id,
      ...(!variantsMode() || !preserveAvatar ? avatar : {}),
      versionId: submission.versionId,
      publishedAt: now,
      // Approving a new version re-lists the Skill, including after an admin unlisting.
      withdrawnAt: null,
      withdrawnBy: null,
      withdrawnReason: null,
    },
  })
  await transaction.skill.update({
    where: { id: submission.skillId },
    data: { visibility: 'public', marketplaceStatus: 'approved' },
  })
}

/**
 * `sort=rising` ranks by install intents in the last 7 days, which no column
 * holds, so the ids of every matching listing are ranked in memory and only
 * the requested page is loaded in full. That scan grows with the catalogue; move
 * the weekly count into a maintained column before it reaches tens of thousands.
 */
async function risingPage(
  where: Prisma.MarketplaceListingWhereInput,
  skip: number,
  take: number,
): Promise<{ total: number; listings: ListingRecord[]; trends: Map<string, ListingTrend> }> {
  const candidates = await db.marketplaceListing.findMany({
    where,
    select: { skillId: true, publishedAt: true },
  })
  // Counted across all public listings (no IN list), then read per candidate.
  const { recent, previous } = await trendCounts('week')
  const pageIds = rankRising(candidates, recent, previous).slice(skip, skip + take).map((row) => row.skillId)
  const rows = pageIds.length === 0 ? [] : await db.marketplaceListing.findMany({
    where: { ...where, skillId: { in: pageIds } },
    include: listingInclude,
  })
  const byId = new Map(rows.map((row) => [row.skillId, row]))
  const listings = pageIds.flatMap((id) => {
    const row = byId.get(id)
    return row ? [row] : []
  })
  const trends = new Map(listings.map((row) => [
    row.skillId,
    listingTrend(recent.get(row.skillId) ?? 0, previous.get(row.skillId) ?? 0),
  ]))
  return { total: candidates.length, listings, trends }
}

export const marketplaceRoutes: FastifyPluginAsync<{ agentAccess?: AdminAgentAccess }> = async (fastify, options) => {
  const agent = Boolean(options.agentAccess)
  const adminPath = agent ? '' : '/admin'
  if (options.agentAccess) configureAgentRoutes(fastify, options.agentAccess)
  const packageReads = new AttemptLimiter()
  const publicReads = new AttemptLimiter()
  const submissionWrites = new AttemptLimiter()
  const withdrawalWrites = new AttemptLimiter()
  const countedDownloads = new AttemptLimiter()
  const validatedPackages = new Map<string, true>()
  if (!agent) fastify.post<{ Params: { skillId: string }; Body: unknown }>('/:skillId/avatar', { preHandler: authMiddleware }, async (
    request: FastifyRequest<{ Params: { skillId: string }; Body: unknown }>, reply: FastifyReply,
  ): Promise<FastifyReply> => {
    if (!variantsMode()) return reply.notFound()
    const id = z.string().uuid().safeParse(request.params.skillId)
    const body = z.object({ expectedUpdatedAt: z.string().datetime(), expectedSelectionRevision: z.number().int().positive() }).strict().safeParse(request.body)
    if (!id.success || !body.success) return reply.badRequest('头像更新参数无效')
    const result = await db.$transaction(async tx => {
      await lockUserMutation(tx, request.user.id)
      await lockSkillMutation(tx, id.data)
      const skill = await tx.skill.findUnique({ where: { id: id.data }, select: { authorId: true, deletedAt: true } })
      if (!skill || skill.deletedAt) throw fastify.httpErrors.notFound('Skill 不存在')
      if (skill.authorId !== request.user.id) throw fastify.httpErrors.forbidden('只有作者可更新商店头像')
      const listing = await tx.marketplaceListing.findUnique({ where: { skillId: id.data } })
      if (!listing) throw fastify.httpErrors.notFound('商店记录不存在')
      const selection = await readOwnerSelection(tx, id.data)
      if (listing.updatedAt.toISOString() !== body.data.expectedUpdatedAt || selection?.revision !== body.data.expectedSelectionRevision) throw fastify.httpErrors.conflict('头像或商店记录已变化，请刷新')
      const display = selectionAvatar(selection)
      if (display.avatarStatus !== 'ready' || !display.avatarUrl) throw fastify.httpErrors.conflict('当前头像尚未就绪')
      const now = new Date()
      const updated = await tx.marketplaceListing.updateMany({ where: { skillId: id.data, updatedAt: listing.updatedAt }, data: {
        ...display, avatarSnapshotAt: now, avatarUpdatedById: request.user.id,
        updatedAt: new Date(Math.max(now.getTime(), listing.updatedAt.getTime() + 1)),
      } })
      if (updated.count !== 1) throw fastify.httpErrors.conflict('商店记录已变化，请刷新')
      const saved = await tx.marketplaceListing.findUniqueOrThrow({ where: { skillId: id.data } })
      return { ...display, avatarSnapshotAt: saved.avatarSnapshotAt, avatarUpdatedById: saved.avatarUpdatedById, updatedAt: saved.updatedAt }
    })
    return reply.send(result)
  })

  function rememberValidatedPackage(cacheKey: string): void {
    validatedPackages.delete(cacheKey)
    validatedPackages.set(cacheKey, true)
    const oldest = validatedPackages.keys().next().value as string | undefined
    if (validatedPackages.size > 256 && oldest) validatedPackages.delete(oldest)
  }

  async function withPackageBytes<T extends PackageVersion>(request: FastifyRequest, version: T): Promise<T> {
    const packageData = await loadVersionPackage(version, (error) => {
      request.log.warn({
        versionId: version.id,
        error: error instanceof Error ? error.message : 'unknown card read error',
      }, 'Skill card unavailable; using the database package copy')
    })
    return { ...version, packageData }
  }

  function cachedValidatedPackage(version: PackageVersion): ReturnType<typeof verifiedPackageBytes> {
    const result = verifiedPackageBytes(version)
    const cacheKey = `${version.id}:${result.packageSha256}`
    if (validatedPackages.has(cacheKey)) {
      validatedPackages.delete(cacheKey)
      validatedPackages.set(cacheKey, true)
    } else {
      validatePublicSkillPackage(result.packageData)
      rememberValidatedPackage(cacheKey)
    }
    return result
  }

  function fullyInspectMarketplacePackage(submission: {
    id: string
    versionId: string
    version: PackageVersion
  }): { serialized: string } {
    const verified = cachedValidatedPackage(submission.version)
    const inspection = inspectPublicSkillPackage(verified.packageData)
    const payload = {
      submissionId: submission.id,
      versionId: submission.versionId,
      version: submission.version.version,
      packageSha256: verified.packageSha256,
      packageSize: verified.packageData.length,
      totalUncompressedBytes: inspection.totalUncompressedBytes,
      readableTextBytes: inspection.readableTextBytes,
      files: inspection.files,
    }
    const serialized = JSON.stringify(payload)
    if (Buffer.byteLength(serialized, 'utf8') > SKILL_PACKAGE_REVIEW_LIMITS.maxSerializedResponseBytes) {
      throw new MarketplacePackageReviewLimitError(
        'Marketplace package review response exceeds the safety limit'
      )
    }
    return { serialized }
  }

  function rejectRateLimited(
    reply: FastifyReply,
    limiter: AttemptLimiter,
    key: string,
    limit: number,
    windowMs: number,
    message: string
  ): boolean {
    const retryAfter = limiter.consume(key, limit, windowMs)
    if (retryAfter === null) return false
    reply.header('Retry-After', String(retryAfter)).tooManyRequests(message)
    return true
  }

  async function sendPackage(
    request: FastifyRequest,
    reply: FastifyReply,
    skillName: string,
    version: PackageVersion,
    countDownloadForSkillId?: string,
    expectedSubmissionId?: string
  ) {
    let result: ReturnType<typeof verifiedPackageBytes>
    try {
      result = cachedValidatedPackage(await withPackageBytes(request, version))
    } catch (error: unknown) {
      request.log.warn({
        versionId: version.id,
        error: error instanceof Error ? error.message : 'unknown package validation error',
      }, 'Blocked an unsafe Marketplace Skill package download')
      return reply.code(409).send({
        error: 'Marketplace Skill package failed safety validation; the author must submit a new version',
      })
    }

    if (countDownloadForSkillId && expectedSubmissionId) {
      const firstCountedDownload = countedDownloads.consume(
        `marketplace-download-count:${countDownloadForSkillId}:${request.ip}`,
        1,
        MARKETPLACE_ABUSE_LIMITS.downloadCountWindowMs
      ) === null
      if (firstCountedDownload) {
        // The running total and today's counter (热门, store figures) move together or not at all.
        const counted = await db.$transaction(async (transaction) => {
          const updated = await transaction.marketplaceListing.updateMany({
            where: {
              skillId: countDownloadForSkillId,
              submissionId: expectedSubmissionId,
              withdrawnAt: null,
            },
            data: { downloadCount: { increment: 1 } },
          })
          if (updated.count === 0) return false
          await recordListingMetric(transaction, countDownloadForSkillId, 'downloads')
          return true
        })
        if (!counted) return reply.notFound('Marketplace listing not found')
      }
    }

    reply
      .header('Cache-Control', 'no-store')
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', skillPackageContentDisposition(skillName))
      .header('X-Skill-Version', version.version)
      .header('X-Checksum-Sha256', result.packageSha256)
    return reply.send(result.packageData)
  }

  // Public Marketplace catalog. Approval and an active Listing, not the legacy
  // Skill visibility strings, are the authorization source of truth.
  if (!agent) {
  fastify.get('/', async (request, reply) => {
    if (rejectRateLimited(
      reply,
      publicReads,
      `marketplace-public:${request.ip}`,
      MARKETPLACE_ABUSE_LIMITS.publicReadsPerMinute,
      60_000,
      'Too many Marketplace catalog requests. Try again later.'
    )) return
    const query = MarketplaceListQuery.safeParse(request.query)
    if (!query.success) return reply.badRequest(query.error.message)

    const submissionWhere: Prisma.MarketplaceSubmissionWhereInput = {
      status: 'approved',
      ...(query.data.label ? { labels: { array_contains: [query.data.label] } } : {}),
      ...(query.data.agent ? { compatibleAgents: { array_contains: [query.data.agent] } } : {}),
      ...(query.data.apiKey === 'none' ? { NOT: { envDependencies: { array_contains: [{ required: true }] } } } : {}),
      ...(query.data.apiKey === 'required' ? { envDependencies: { array_contains: [{ required: true }] } } : {}),
      ...(query.data.query ? {
        OR: [
          { skillName: { contains: query.data.query, mode: 'insensitive' } },
          { displayName: { contains: query.data.query, mode: 'insensitive' } },
          { description: { contains: query.data.query, mode: 'insensitive' } },
          { labels: { array_contains: [query.data.query] } },
        ],
      } : {}),
    }
    const where: Prisma.MarketplaceListingWhereInput = {
      withdrawnAt: null,
      ...(query.data.featured !== undefined ? { featured: query.data.featured } : {}),
      skill: { is: { deletedAt: null } },
      ...(query.data.category ? {
        OR: [
          { category: { is: { OR: [{ slug: query.data.category }, { name: query.data.category }] } } },
          { categoryId: null, submission: { is: { ...submissionWhere, category: query.data.category } } },
        ],
        submission: { is: submissionWhere },
      } : { submission: { is: submissionWhere } }),
    }
    const skip = (query.data.page - 1) * query.data.pageSize
    const orderBy: Prisma.MarketplaceListingOrderByWithRelationInput[] = query.data.sort === 'users'
      ? [{ activeUserCount: 'desc' }, { installClickCount: 'desc' }, { publishedAt: 'desc' }]
      : query.data.sort === 'popular'
        ? [{ installClickCount: 'desc' }, { activeUserCount: 'desc' }, { publishedAt: 'desc' }]
        : query.data.sort === 'downloads'
          ? [{ downloadCount: 'desc' }, { publishedAt: 'desc' }, { skillId: 'asc' }]
        : [{ firstPublishedAt: 'desc' }, { skillId: 'asc' }]
    const [page, managedCategories, categoryRows, hotSkillIds] = await Promise.all([
      query.data.sort === 'rising'
        ? risingPage(where, skip, query.data.pageSize)
        : Promise.all([
          db.marketplaceListing.count({ where }),
          db.marketplaceListing.findMany({
            where,
            include: listingInclude,
            orderBy,
            skip,
            take: query.data.pageSize,
          }),
        ]).then(([total, listings]) => ({ total, listings, trends: undefined })),
      db.marketplaceCategory.findMany({
        where: { enabled: true },
        select: { name: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      db.marketplaceSubmission.findMany({
        where: {
          status: 'approved',
          category: { not: null },
          listing: {
            is: {
              withdrawnAt: null,
              skill: { is: { deletedAt: null } },
            },
          },
        },
        select: { category: true },
        distinct: ['category'],
        orderBy: { category: 'asc' },
      }),
      loadHotSkillIds(),
    ])
    const categories = [...new Set([
      ...managedCategories.map(({ name }) => name),
      ...categoryRows.flatMap(({ category }) => (
      typeof category === 'string' && category.trim().length > 0 ? [category] : []
      )),
    ])].sort((left, right) => left.localeCompare(right, 'zh-CN'))
    return {
      items: page.listings.map((listing) => marketplaceItem(listing, false, hotSkillIds, page.trends?.get(listing.skillId))),
      total: page.total,
      page: query.data.page,
      pageSize: query.data.pageSize,
      categories,
    }
  })

  fastify.get<{ Params: { id: string } }>('/mine/:id', { preHandler: catalogAuthMiddleware }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
    const submission = await db.marketplaceSubmission.findFirst({ where: { id: request.params.id, submittedById: request.user.id, skill: { deletedAt: null } }, include: submissionInclude })
    if (!submission) return reply.notFound('Marketplace submission not found')
    return reply.send(submissionDto(submission))
  })

  fastify.post<{ Body: unknown }>('/catalog-submissions', { preHandler: catalogAuthMiddleware, bodyLimit: 30 * 1024 * 1024 }, async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const body = CatalogSubmissionBody.safeParse(request.body)
    if (!body.success) return reply.badRequest(body.error.message)
    const { clientOperationId, name, profile, compatibleAgents, envDependencies, packageBase64, packageSha256, skillMd, sourceOrigin, sourceSkillId, note } = body.data
    const requestDigest = createHash('sha256').update(JSON.stringify({ ...body.data, packageBase64: undefined })).digest('hex')
    let packageData: Buffer
    let packageEnv: ReturnType<typeof decodePackageWithEnv>['env']
    try {
      const decoded = decodePackageWithEnv(packageBase64, packageSha256, skillMd)
      if (!decoded.packageFields.packageData) return reply.badRequest('A complete package is required')
      packageData = decoded.packageFields.packageData
      packageEnv = decoded.env
      fullyInspectMarketplacePackage({ id: clientOperationId, versionId: clientOperationId, version: { id: clientOperationId, version: body.data.version, packageData, packageSha256 } })
    } catch (error: unknown) {
      return reply.badRequest(error instanceof Error ? error.message : 'Invalid Skill package')
    }
    const sourceContent = validatePublicSkillPackage(packageData).skillMd
    const outcome = packageEnvOutcome(packageEnv, sourceContent, envDependencies, () => [])
    if (!outcome.ok) return reply.badRequest(outcome.message)
    const snapshot = { skillName: name, ...profile, compatibleAgents, envDependencies: outcome.envDependencies ?? envDependencies, sourceContent }
    if (containsSensitivePublicMetadata({ ...snapshot, changelog: null })) return reply.badRequest('Sensitive public metadata')
    // A committed response remains recoverable while object storage is unavailable.
    const completed = await db.catalogSubmissionOperation.findUnique({ where: { userId_clientOperationId: { userId: request.user.id, clientOperationId } }, include: { submission: { include: submissionInclude } } })
    if (completed) {
      if (completed.requestDigest !== requestDigest) return reply.conflict('Operation key already used with different content')
      return reply.send(submissionDto(completed.submission))
    }
    if (rejectRateLimited(reply, submissionWrites, `marketplace-submit:${request.user.id}`, MARKETPLACE_ABUSE_LIMITS.submissionWritesPerHour, 3600000, 'Too many Marketplace submissions. Try again later.')) return reply
    const card = await prepareCard(packageData).catch(() => null)
    if (!card) return reply.serviceUnavailable('Skill card storage unavailable')
    const result = await db.$transaction(async (tx) => {
      await lockUserMutation(tx, request.user.id)
      const user = await tx.user.findUnique({ where: { id: request.user.id } })
      if (!user || (request.verifiedCatalogToken
        ? !await catalogTokenCurrent(tx, request.verifiedCatalogToken)
        : user.tokenVersion !== request.verifiedAuthToken?.ver)) throw fastify.httpErrors.unauthorized()
      const prior = await tx.catalogSubmissionOperation.findUnique({ where: { userId_clientOperationId: { userId: user.id, clientOperationId } }, include: { submission: { include: submissionInclude } } })
      if (prior) {
        if (prior.requestDigest !== requestDigest) throw fastify.httpErrors.conflict('Operation key already used with different content')
        return { created: false, submission: prior.submission }
      }
      const source = await tx.catalogSkillSource.findUnique({ where: { userId_sourceOrigin_sourceSkillId: { userId: user.id, sourceOrigin, sourceSkillId } } })
      const skillId = source?.skillId ?? randomUUID()
      await lockSkillMutation(tx, skillId)
      const existing = await tx.skill.findUnique({ where: { id: skillId } })
      if (source && (!existing || existing.deletedAt || existing.authorId !== user.id || existing.storeCopy)) throw fastify.httpErrors.conflict('Source Skill is no longer publishable')
      await requireCardAuthorship(tx, user.id, card.sha256)
      if (await tx.marketplaceSubmission.findFirst({ where: { skillId, status: { in: [...activeSubmissionStatuses] } } })) throw fastify.httpErrors.conflict('This Skill already has an active Marketplace submission')
      if (await tx.marketplaceSubmission.count({ where: { skillId } }) >= MARKETPLACE_ABUSE_LIMITS.maxSubmissionHistoryPerSkill) throw fastify.httpErrors.conflict('Marketplace submission history limit reached')
      if (existing) {
        if (await tx.skillVersion.count({ where: { skillId } }) >= config.SKILL_MAX_VERSIONS_PER_SKILL) throw fastify.httpErrors.conflict('Skill version limit reached')
      } else {
        if (await tx.skill.findFirst({ where: { authorId: user.id, name } })) throw fastify.httpErrors.conflict('An owned Skill with this name already exists')
        const active = await tx.skill.count({ where: { authorId: user.id, deletedAt: null } })
        const total = await tx.skill.count({ where: { authorId: user.id } })
        if (active >= config.SKILL_MAX_PER_USER || total >= config.SKILL_MAX_PER_USER * 20) throw fastify.httpErrors.conflict('Skill account limit reached')
      }
      if (await userStoredPackageBytes(user.id, tx) + card.size > config.SKILL_MAX_STORAGE_BYTES_PER_USER) throw fastify.httpErrors.payloadTooLarge('Skill storage quota exceeded')
      const version = existing ? allocateVersion(await skillHighWater(tx, existing.id), body.data.version) : body.data.version
      await registerCard(tx, card, user.id)
      const fields = { name, ...profile, compatibleAgents, envDependencies: snapshot.envDependencies, sourceContent, currentVersion: version, versionHighWater: requireVersion(version) }
      if (existing) await tx.skill.update({ where: { id: skillId }, data: fields })
      else await tx.skill.create({ data: { id: skillId, authorId: user.id, ...fields } })
      const versionId = randomUUID()
      await tx.skillVersion.create({ data: { id: versionId, skillId, version, ...snapshot, ...(outcome.detectedUndeclared ? { detectedUndeclared: outcome.detectedUndeclared } : {}), profileSnapshotVersion: 1, packageSha256, packageSize: card.size, cardSha256: card.sha256, mutationDigest: requestDigest } })
      if (!existing) {
        await tx.skill.update({ where: { id: skillId }, data: { importVersionId: versionId } })
        await tx.catalogSkillSource.create({ data: { userId: user.id, sourceOrigin, sourceSkillId, skillId } })
      }
      await grantCard(tx, user.id, card.sha256, 'authored', `skill:${skillId}`)
      const submission = await tx.marketplaceSubmission.create({ data: { skillId, versionId, ...snapshot, status: 'submitted', submittedById: user.id, submitterNote: note }, include: submissionInclude })
      const listing = await tx.marketplaceListing.findFirst({ where: { skillId, withdrawnAt: null } })
      await tx.skill.update({ where: { id: skillId }, data: { marketplaceStatus: listing ? 'approved' : 'submitted' } })
      await tx.catalogSubmissionOperation.create({ data: { userId: user.id, clientOperationId, requestDigest, submissionId: submission.id } })
      return { created: true, submission }
    })
    return reply.code(result.created ? 201 : 200).send(submissionDto(result.submission))
  })

  // Author view deliberately returns an active public Listing and the latest
  // submission separately, so an approved old release may coexist with a new
  // version that is still being reviewed.
  fastify.get('/mine', { preHandler: catalogAuthMiddleware }, async (request) => {
    const skills = await db.skill.findMany({
      where: {
        authorId: request.user.id,
        deletedAt: null,
        OR: [
          { marketplaceSubmissions: { some: {} } },
          { marketplaceListing: { isNot: null } },
        ],
      },
      select: {
        id: true,
        name: true,
        displayName: true,
        currentVersion: true,
        updatedAt: true,
        marketplaceListing: {
          include: { version: { select: { id: true, version: true } } },
        },
        marketplaceSubmissions: {
          orderBy: { submittedAt: 'desc' },
          take: 1,
          include: submissionInclude,
        },
      },
      orderBy: { updatedAt: 'desc' },
    })
    return {
      items: skills.map((skill) => {
        const activeListing = skill.marketplaceListing?.withdrawnAt
          ? null
          : skill.marketplaceListing
        return {
          skillId: skill.id,
          skill: {
            id: skill.id,
            name: skill.name,
            displayName: skill.displayName,
            currentVersion: skill.currentVersion,
          },
          listing: activeListing ? {
            submissionId: activeListing.submissionId,
            versionId: activeListing.versionId,
            version: activeListing.version.version,
            downloadCount: activeListing.downloadCount,
            publishedAt: activeListing.publishedAt,
            withdrawnAt: activeListing.withdrawnAt,
          } : null,
          latestSubmission: skill.marketplaceSubmissions[0]
            ? submissionDto(skill.marketplaceSubmissions[0])
            : null,
        }
      }),
    }
  })

  fastify.post<{ Params: { skillId: string }; Body: unknown }>(
    '/skills/:skillId/submissions',
    { preHandler: catalogAuthMiddleware },
    async (request: FastifyRequest<{ Params: { skillId: string }; Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
      const body = SubmitMarketplaceBody.safeParse(request.body)
      if (!body.success) return reply.badRequest(body.error.message)
      if (rejectRateLimited(
        reply,
        submissionWrites,
        `marketplace-submit:${request.user.id}`,
        MARKETPLACE_ABUSE_LIMITS.submissionWritesPerHour,
        60 * 60 * 1_000,
        'Too many Marketplace submissions. Try again later.'
      )) return reply

      const candidate = await db.skill.findUnique({
        where: { id: request.params.skillId },
        include: {
          versions: {
            where: { id: body.data.versionId },
            select: {
              id: true,
              skillId: true,
              version: true,
              changelog: true,
              packageData: true,
              cardSha256: true,
              packageSha256: true,
              packageSize: true,
              profileSnapshotVersion: true,
              skillName: true,
              displayName: true,
              description: true,
              category: true,
              labels: true,
              triggerScenarios: true,
              compatibleAgents: true,
              envDependencies: true,
              sourceContent: true,
              sourceUrl: true,
              createdAt: true,
            },
            take: 1,
          },
        },
      })
      if (!candidate || candidate.deletedAt) return reply.notFound('Skill not found')
      if (candidate.authorId !== request.user.id) return reply.forbidden()
      if (candidate.storeCopy) return reply.code(403).send({ code: 'MIGRATION_STORE_COPY_NOT_PUBLISHABLE', error: 'Official store personal copies cannot be published' })
      const version = candidate.versions[0]
      if (!version || version.skillId !== candidate.id) return reply.notFound('Skill version not found')
      if (!completeProfileSnapshot(version)) {
        return reply.conflict('The selected version has no complete public Profile snapshot; upload it again')
      }
      if (containsSensitivePublicMetadata({
        skillName: version.skillName,
        displayName: version.displayName,
        description: version.description,
        category: version.category,
        labels: version.labels,
        triggerScenarios: version.triggerScenarios,
        compatibleAgents: version.compatibleAgents,
        envDependencies: version.envDependencies,
        sourceContent: version.sourceContent,
        sourceUrl: version.sourceUrl,
        changelog: version.changelog,
      })) {
        return reply.conflict('The selected version contains sensitive public metadata')
      }
      if (!version.packageSha256) {
        return reply.conflict('The selected version has no safe installable package')
      }
      try {
        cachedValidatedPackage(await withPackageBytes(request, version))
      } catch {
        return reply.conflict('The selected version has no safe installable package')
      }

      try {
        const result = await db.$transaction(async (transaction) => {
          await lockUserMutation(transaction, request.user.id)
          await lockSkillMutation(transaction, request.params.skillId)
          const skill = await transaction.skill.findUnique({ where: { id: request.params.skillId } })
          if (!skill || skill.deletedAt) return { outcome: 'not_found' } as const
          if (skill.authorId !== request.user.id) return { outcome: 'forbidden' } as const
          await requireCardAuthorship(transaction, request.user.id, version.cardSha256 ?? version.packageSha256!)
          const active = await transaction.marketplaceSubmission.findFirst({
            where: { skillId: skill.id, status: { in: [...activeSubmissionStatuses] } },
            select: { id: true },
          })
          if (active) return { outcome: 'active_submission' } as const
          const submissionHistoryCount = await transaction.marketplaceSubmission.count({
            where: { skillId: skill.id },
          })
          if (submissionHistoryCount >= MARKETPLACE_ABUSE_LIMITS.maxSubmissionHistoryPerSkill) {
            return { outcome: 'history_limit' } as const
          }
          const activeListing = await transaction.marketplaceListing.findFirst({
            where: { skillId: skill.id, withdrawnAt: null },
            select: { skillId: true },
          })

          const submission = await transaction.marketplaceSubmission.create({
            data: {
              skillId: skill.id,
              versionId: version.id,
              submittedById: request.user.id,
              status: 'submitted',
              submitterNote: body.data.note,
              skillName: version.skillName as string,
              displayName: version.displayName as string,
              description: version.description,
              category: version.category,
              labels: jsonArraySnapshot(version.labels as Prisma.JsonValue),
              triggerScenarios: jsonArraySnapshot(version.triggerScenarios as Prisma.JsonValue),
              compatibleAgents: jsonArraySnapshot(version.compatibleAgents as Prisma.JsonValue),
              envDependencies: jsonArraySnapshot(version.envDependencies as Prisma.JsonValue),
              sourceContent: version.sourceContent as string,
              sourceUrl: version.sourceUrl,
            },
            include: submissionInclude,
          })
          await transaction.skill.update({
            where: { id: skill.id },
            data: { marketplaceStatus: activeListing ? 'approved' : 'submitted' },
          })
          return { outcome: 'created', submission } as const
        })
        if (result.outcome === 'not_found') return reply.notFound('Skill not found')
        if (result.outcome === 'forbidden') return reply.forbidden()
        if (result.outcome === 'active_submission') {
          return reply.conflict('This Skill already has an active Marketplace submission')
        }
        if (result.outcome === 'history_limit') {
          return reply.conflict('This Skill has reached the Marketplace submission history limit')
        }
        return reply.code(201).send(submissionDto(result.submission))
      } catch (error: unknown) {
        if (isUniqueConstraintError(error)) {
          return reply.conflict('This Skill already has an active Marketplace submission')
        }
        throw error
      }
    }
  )

  fastify.post<{ Params: { id: string } }>(
    '/submissions/:id/withdraw',
    { preHandler: catalogAuthMiddleware },
    async (request, reply) => {
      if (rejectRateLimited(
        reply,
        withdrawalWrites,
        `marketplace-withdraw:${request.user.id}`,
        MARKETPLACE_ABUSE_LIMITS.submissionWritesPerHour,
        60 * 60 * 1_000,
        'Too many Marketplace withdrawals. Try again later.'
      )) return
      const candidate = await db.marketplaceSubmission.findUnique({
        where: { id: request.params.id },
        select: { skillId: true },
      })
      if (!candidate) return reply.notFound('Marketplace submission not found')
      const result = await db.$transaction(async (transaction) => {
        await lockSkillMutation(transaction, candidate.skillId)
        const submission = await transaction.marketplaceSubmission.findUnique({
          where: { id: request.params.id },
        })
        if (!submission) return { outcome: 'not_found' } as const
        if (submission.submittedById !== request.user.id) return { outcome: 'forbidden' } as const
        if (!activeSubmissionStatuses.includes(submission.status as typeof activeSubmissionStatuses[number])) {
          return { outcome: 'resolved' } as const
        }
        const now = new Date()
        const updated = await transaction.marketplaceSubmission.update({
          where: { id: submission.id },
          data: { status: 'withdrawn', withdrawnAt: now },
          include: submissionInclude,
        })
        const listing = await transaction.marketplaceListing.findFirst({
          where: { skillId: submission.skillId, withdrawnAt: null },
          select: { skillId: true },
        })
        await transaction.skill.update({
          where: { id: submission.skillId },
          data: { marketplaceStatus: listing ? 'approved' : 'none' },
        })
        return { outcome: 'withdrawn', submission: updated } as const
      })
      if (result.outcome === 'not_found') return reply.notFound('Marketplace submission not found')
      if (result.outcome === 'forbidden') return reply.forbidden()
      if (result.outcome === 'resolved') return reply.conflict('Marketplace submission is already resolved')
      return submissionDto(result.submission)
    }
  )

  fastify.delete<{ Params: { skillId: string } }>(
    '/skills/:skillId',
    { preHandler: catalogAuthMiddleware },
    async (request, reply) => {
      const result = await db.$transaction(async (transaction) => {
        await lockSkillMutation(transaction, request.params.skillId)
        const skill = await transaction.skill.findUnique({ where: { id: request.params.skillId } })
        if (!skill || skill.deletedAt) return { outcome: 'not_found' } as const
        if (skill.authorId !== request.user.id) return { outcome: 'forbidden' } as const
        await markListingWithdrawnByAuthor(transaction, skill.id, new Date())
        const activeSubmission = await transaction.marketplaceSubmission.findFirst({
          where: { skillId: skill.id, status: { in: [...activeSubmissionStatuses] } },
          select: { status: true },
        })
        await transaction.skill.update({
          where: { id: skill.id },
          data: {
            visibility: 'private',
            marketplaceStatus: activeSubmission?.status ?? 'none',
          },
        })
        return { outcome: 'unpublished' } as const
      })
      if (result.outcome === 'not_found') return reply.notFound('Skill not found')
      if (result.outcome === 'forbidden') return reply.forbidden()
      return reply.code(204).send()
    }
  )

  }
  const adminPreHandlers = agent ? [requireAgentScope('marketplace:review')] : [authMiddleware, marketplaceAdminMiddleware]

  fastify.post<{ Params: { id: string }; Body: unknown }>(`${adminPath}/listings/:id/source`, { preHandler: adminPreHandlers }, async (request, reply: FastifyReply): Promise<FastifyReply> => {
    const body = z.object({ sourceUrl: SkillSourceUrlSchema, expectedUpdatedAt: z.string().datetime() }).strict().safeParse(request.body)
    if (!body.success || body.data.sourceUrl === undefined) return reply.badRequest('来源和最新记录时间必填；清空来源请传 null')
    const sourceUrl = body.data.sourceUrl
    const result = await db.$transaction(async tx => {
      await lockSkillMutation(tx, request.params.id)
      const listing = await tx.marketplaceListing.findUnique({ where: { skillId: request.params.id }, include: { submission: true, version: true, skill: true } })
      if (!listing || listing.skill.deletedAt) throw fastify.httpErrors.notFound('Skill 不存在')
      if (listing.updatedAt.toISOString() !== body.data.expectedUpdatedAt || listing.withdrawnAt) throw fastify.httpErrors.conflict('记录已变化或已下架，请刷新')
      if (listing.skill.currentVersion !== listing.version.version || await tx.marketplaceSubmission.count({ where: { skillId: listing.skillId, status: { in: [...activeSubmissionStatuses] } } })) throw fastify.httpErrors.conflict('存在未发布版本或待审核投稿，请先处理')
      if (sourceUrl && containsSensitiveContent(sourceUrl)) throw fastify.httpErrors.badRequest('来源包含敏感信息')
      if (listing.submission.sourceUrl === sourceUrl) return { sourceUrl, versionId: listing.versionId, updatedAt: listing.updatedAt }
      if (await tx.skillVersion.count({ where: { skillId: listing.skillId } }) >= config.SKILL_MAX_VERSIONS_PER_SKILL) throw fastify.httpErrors.conflict('版本数量已达上限')
      if (await tx.marketplaceSubmission.count({ where: { skillId: listing.skillId } }) >= MARKETPLACE_ABUSE_LIMITS.maxSubmissionHistoryPerSkill) throw fastify.httpErrors.conflict('投稿历史已达上限')
      const version = allocateVersion(await skillHighWater(tx, listing.skillId))
      const snapshot = {
        skillName: listing.submission.skillName, displayName: listing.submission.displayName,
        description: listing.submission.description, category: listing.submission.category,
        labels: jsonArraySnapshot(listing.submission.labels), triggerScenarios: jsonArraySnapshot(listing.submission.triggerScenarios),
        compatibleAgents: jsonArraySnapshot(listing.submission.compatibleAgents), envDependencies: jsonArraySnapshot(listing.submission.envDependencies),
        sourceContent: listing.submission.sourceContent, sourceUrl,
      }
      const saved = await tx.skillVersion.create({ data: {
        skillId: listing.skillId, version, ...snapshot, profileSnapshotVersion: 1,
        changelog: '更新来源', packageData: listing.version.packageData,
        cardSha256: listing.version.cardSha256, packageSha256: listing.version.packageSha256,
        packageSize: listing.version.packageSize,
        detectedUndeclared: listing.version.detectedUndeclared ?? Prisma.JsonNull,
      } })
      const now = new Date()
      const submission = await tx.marketplaceSubmission.create({ data: {
        skillId: listing.skillId, versionId: saved.id, ...snapshot, status: 'approved',
        submittedById: listing.skill.authorId, reviewerId: request.user.id, reviewedAt: now,
        submitterNote: '管理员更新来源',
      } })
      await tx.skill.update({ where: { id: listing.skillId }, data: { sourceUrl, currentVersion: version, versionHighWater: requireVersion(version) } })
      await publishApprovedListing(tx, submission, now, true)
      await auditAdminMutation(tx, request, 'marketplace.listing.source', 'marketplace:review', listing.skillId)
      const updated = await tx.marketplaceListing.findUniqueOrThrow({ where: { skillId: listing.skillId } })
      return { sourceUrl, versionId: saved.id, updatedAt: updated.updatedAt }
    })
    return reply.send(result)
  })

  {
    fastify.post<{ Body: unknown }>(`${adminPath}/skills/publish`, { preHandler: agent ? [requireAgentScope('marketplace:publish')] : adminPreHandlers, bodyLimit: 30 * 1024 * 1024 }, async (request, reply: FastifyReply): Promise<FastifyReply> => {
      const body = AdminPublishBody.safeParse(request.body)
      if (!body.success) return reply.badRequest(`Invalid publish fields: ${body.error.issues.map(issue => issue.path.join('.')).join(', ')}`)
      const { clientOperationId: skillId, name, version, profile, compatibleAgents, envDependencies, packageBase64, packageSha256 } = body.data
      let packageData: Buffer
      let packageEnv: ReturnType<typeof decodePackageWithEnv>['env']
      try {
        const decoded = decodePackageWithEnv(packageBase64, packageSha256)
        if (!decoded.packageFields.packageData) return reply.badRequest('A complete package is required')
        packageData = decoded.packageFields.packageData
        packageEnv = decoded.env
        fullyInspectMarketplacePackage({ id: skillId, versionId: skillId, version: { id: skillId, version, packageData, packageSha256 } })
      } catch (error: unknown) {
        if (error instanceof SkillPackageValidationError && error.message.startsWith('SKILL.md metadata.skillhub.env')) {
          return reply.badRequest(error.message)
        }
        return reply.badRequest('Package failed complete Marketplace safety validation')
      }
      const sourceContent = validatePublicSkillPackage(packageData).skillMd
      // Package declaration ∪ submitted list (#251); the digest stays over the request.
      const envOutcome = packageEnvOutcome(packageEnv, sourceContent, envDependencies, () => [])
      if (!envOutcome.ok) return reply.badRequest(envOutcome.message)
      const storedEnvDependencies = envOutcome.envDependencies ?? envDependencies
      const snapshot = { skillName: name, ...profile, compatibleAgents, envDependencies: storedEnvDependencies, sourceContent }
      if (containsSensitivePublicMetadata({ ...snapshot, changelog: null })) return reply.badRequest('Sensitive public metadata')
      const { sourceUrl, ...legacyProfile } = profile
      const digestProfile = sourceUrl ? { ...legacyProfile, sourceUrl } : legacyProfile
      const digest = 'admin-publish:' + createHash('sha256').update(JSON.stringify({ name, version, profile: digestProfile, compatibleAgents, envDependencies, packageSha256 })).digest('hex')
      const card = await prepareCard(packageData).catch(() => null)
      if (!card) return reply.serviceUnavailable('Skill card storage unavailable')
      const result = await db.$transaction(async tx => {
        await lockUserMutation(tx, request.user.id)
        await lockSkillMutation(tx, skillId)
        const existing = await tx.skill.findUnique({ where: { id: skillId }, include: { importVersion: true, marketplaceListing: true } })
        if (existing) {
          if (existing.authorId !== request.user.id || existing.deletedAt || existing.importVersion?.mutationDigest !== digest || !existing.marketplaceListing || existing.marketplaceListing.withdrawnAt || existing.marketplaceListing.versionId !== existing.importVersion.id) throw fastify.httpErrors.conflict('Publish request conflicts with existing Skill; read back before retrying')
          await auditAdminMutation(tx, request, 'marketplace.publish', 'marketplace:publish', skillId)
          return { skillId, versionId: existing.importVersion.id, submissionId: existing.marketplaceListing.submissionId, packageSha256, sourceUrl: existing.importVersion.sourceUrl, created: false }
        }
        if (await tx.skill.findFirst({ where: { authorId: request.user.id, name }, select: { id: true } })) throw fastify.httpErrors.conflict('An owned Skill with this name already exists')
        const count = await tx.skill.count({ where: { authorId: request.user.id, deletedAt: null } })
        const total = await tx.skill.count({ where: { authorId: request.user.id } })
        if (count >= config.SKILL_MAX_PER_USER || total >= config.SKILL_MAX_PER_USER * 20) throw fastify.httpErrors.conflict('Skill account limit reached')
        if (await userStoredPackageBytes(request.user.id, tx) + card.size > config.SKILL_MAX_STORAGE_BYTES_PER_USER) throw fastify.httpErrors.payloadTooLarge('Skill storage quota exceeded')
        await registerCard(tx, card, request.user.id)
        await tx.skill.create({ data: { id: skillId, name, ...profile, compatibleAgents, envDependencies: storedEnvDependencies, sourceContent, authorId: request.user.id, currentVersion: version, versionHighWater: requireVersion(version) } })
        const versionId = randomUUID()
        await tx.skillVersion.create({ data: { id: versionId, skillId, version, ...snapshot, ...(envOutcome.detectedUndeclared ? { detectedUndeclared: envOutcome.detectedUndeclared } : {}), profileSnapshotVersion: 1, packageSha256, packageSize: card.size, cardSha256: card.sha256, mutationDigest: digest } })
        await tx.skill.update({ where: { id: skillId }, data: { importVersionId: versionId } })
        await grantCard(tx, request.user.id, card.sha256, 'authored', `skill:${skillId}`)
        const now = new Date()
        const submission = await tx.marketplaceSubmission.create({ data: { skillId, versionId, ...snapshot, status: 'approved', submittedById: request.user.id, reviewerId: request.user.id, reviewedAt: now, submitterNote: 'Administrator direct publish' } })
        await publishApprovedListing(tx, submission, now)
        await auditAdminMutation(tx, request, 'marketplace.publish', 'marketplace:publish', skillId)
        return { skillId, versionId, submissionId: submission.id, packageSha256, sourceUrl: sourceUrl ?? null, created: true }
      })
      await queueCloudAvatar(request.user.id, skillId).catch(() => { request.log.warn('Skill avatar enqueue deferred') })
      return reply.code(result.created ? 201 : 200).send(result)
    })
    fastify.get<{ Params: { id: string } }>(`${adminPath}/skills/:id`, { preHandler: agent ? [requireAgentScope('marketplace:publish')] : adminPreHandlers }, async (request, reply: FastifyReply): Promise<FastifyReply> => {
      const skill = await db.skill.findUnique({ where: { id: request.params.id }, include: { importVersion: true, marketplaceListing: true } })
      if (!skill || skill.authorId !== request.user.id || !skill.importVersion?.mutationDigest?.startsWith('admin-publish:')) return reply.notFound('Published Skill not found')
      return reply.send({ skillId: skill.id, versionId: skill.importVersion.id, version: skill.importVersion.version, sourceUrl: skill.importVersion.sourceUrl, packageSha256: skill.importVersion.packageSha256, submissionId: skill.marketplaceListing?.submissionId, status: skill.deletedAt ? 'deleted' : skill.marketplaceListing?.withdrawnAt ? 'withdrawn' : skill.marketplaceStatus })
    })
  }

  fastify.get(`${adminPath}/submissions`, { preHandler: adminPreHandlers }, async (request, reply) => {
    const query = AdminQueueQuery.safeParse(request.query)
    if (!query.success) return reply.badRequest(query.error.message)
    const statuses = query.data.status === 'all' ? ['submitted', 'under_review', 'approved', 'rejected', 'withdrawn']
      : query.data.status ? [query.data.status] : [...activeSubmissionStatuses]
    const where: Prisma.MarketplaceSubmissionWhereInput = {
      status: { in: statuses },
      skill: { deletedAt: null },
      ...(query.data.category ? { category: query.data.category } : {}),
      ...(query.data.search ? { OR: [
        { displayName: { contains: query.data.search, mode: 'insensitive' as const } },
        { skillName: { contains: query.data.search, mode: 'insensitive' as const } },
        { submittedBy: { displayName: { contains: query.data.search, mode: 'insensitive' as const } } },
      ] } : {}),
    }
    const skip = (query.data.page - 1) * query.data.pageSize
    const [total, submissions] = await Promise.all([
      db.marketplaceSubmission.count({ where }),
      db.marketplaceSubmission.findMany({
        where,
        include: adminSubmissionInclude,
        orderBy: [{ submittedAt: query.data.order }, { id: query.data.order }],
        skip,
        take: query.data.pageSize,
      }),
    ])
    return {
      items: submissions.map(adminSubmissionDto),
      total,
      page: query.data.page,
      pageSize: query.data.pageSize,
      totalPages: Math.ceil(total / query.data.pageSize),
    }
  })

  fastify.get<{ Params: { id: string } }>(
    `${adminPath}/submissions/:id`,
    { preHandler: adminPreHandlers },
    async (request, reply) => {
      const submission = await db.marketplaceSubmission.findUnique({
        where: { id: request.params.id },
        include: adminSubmissionInclude,
      })
      if (!submission) return reply.notFound('Marketplace submission not found')
      return adminSubmissionDto(submission)
    }
  )

  if (!agent) {
  fastify.get<{ Params: { id: string } }>(
    `${adminPath}/submissions/:id/package`,
    { preHandler: adminPreHandlers },
    async (request, reply) => {
      const submission = await db.marketplaceSubmission.findUnique({
        where: { id: request.params.id },
        include: {
          version: {
            select: {
              id: true,
              version: true,
              packageData: true,
              cardSha256: true,
              packageSha256: true,
              packageSize: true,
            },
          },
        },
      })
      if (!submission) return reply.notFound('Marketplace submission not found')
      return sendPackage(request, reply, submission.skillName, submission.version)
    }
  )

  }
  fastify.get<{ Params: { id: string } }>(
    `${adminPath}/submissions/:id/package-inspection`,
    { preHandler: adminPreHandlers },
    async (request, reply) => {
      const submission = await db.marketplaceSubmission.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          versionId: true,
          version: {
            select: {
              id: true,
              version: true,
              packageData: true,
              cardSha256: true,
              packageSha256: true,
              packageSize: true,
            },
          },
        },
      })
      if (!submission) return reply.notFound('Marketplace submission not found')
      if (submission.versionId !== submission.version.id) {
        return reply.conflict('Marketplace submission version binding is invalid')
      }

      let serialized: string
      try {
        serialized = fullyInspectMarketplacePackage({
          ...submission,
          version: await withPackageBytes(request, submission.version),
        }).serialized
      } catch (error: unknown) {
        request.log.warn({
          submissionId: submission.id,
          versionId: submission.versionId,
          error: error instanceof Error ? agent ? error.name : error.message : 'unknown package inspection error',
        }, 'Blocked Marketplace package inspection')
        if (error instanceof SkillPackageValidationError
          && error.message === 'Skill package readable text exceeds review limit') {
          return reply.code(413).send({
            error: 'Marketplace package contains too much readable text for complete review',
          })
        }
        if (error instanceof MarketplacePackageReviewLimitError) {
          return reply.code(413).send({ error: error.message })
        }
        return reply.conflict('Submitted Skill package failed safety validation')
      }
      return reply
        .header('Cache-Control', 'no-store')
        .type('application/json; charset=utf-8')
        .send(serialized)
    }
  )

  fastify.post<{ Params: { id: string } }>(
    `${adminPath}/submissions/:id/start`,
    { preHandler: adminPreHandlers },
    async (request, reply) => {
      const binding = ReviewBinding.safeParse(request.body)
      if (agent && (!binding.success || binding.data.expectedStatus !== 'submitted')) return reply.badRequest('A checked version, checksum and submitted status are required')
      const candidate = await db.marketplaceSubmission.findUnique({
        where: { id: request.params.id },
        select: { skillId: true },
      })
      if (!candidate) return reply.notFound('Marketplace submission not found')
      const result = await db.$transaction(async (transaction) => {
        await lockSkillMutation(transaction, candidate.skillId)
        const submission = await transaction.marketplaceSubmission.findUnique({
          where: { id: request.params.id },
          include: { skill: { select: { deletedAt: true } }, version: { select: { packageSha256: true } } },
        })
        if (!submission || submission.skill.deletedAt) return { outcome: 'not_found' } as const
        if (submission.status !== 'submitted') return { outcome: 'resolved' } as const
        if (agent && binding.success && !matchesReviewBinding(submission, binding.data)) return { outcome: 'resolved' } as const
        const updated = await transaction.marketplaceSubmission.update({
          where: { id: submission.id },
          data: {
            status: 'under_review',
            reviewerId: request.user.id,
            reviewStartedAt: new Date(),
          },
          include: submissionInclude,
        })
        const activeListing = await transaction.marketplaceListing.findFirst({
          where: { skillId: submission.skillId, withdrawnAt: null },
          select: { skillId: true },
        })
        await transaction.skill.update({
          where: { id: submission.skillId },
          data: { marketplaceStatus: activeListing ? 'approved' : 'under_review' },
        })
        await auditAgentMutation(transaction, request, 'marketplace.review.start', 'marketplace:review', submission.id)
        return { outcome: 'started', submission: updated } as const
      })
      if (result.outcome === 'not_found') return reply.notFound('Marketplace submission not found')
      if (result.outcome === 'resolved') return reply.conflict('Marketplace submission is not awaiting review')
      return submissionDto(result.submission)
    }
  )

  fastify.post<{ Params: { id: string } }>(
    `${adminPath}/submissions/:id/approve`,
    { preHandler: adminPreHandlers },
    async (request, reply) => {
      const body = ApproveMarketplaceBody.safeParse(request.body ?? {})
      if (!body.success) return reply.badRequest(body.error.message)
      const binding = ReviewBinding.safeParse(request.body)
      if (agent && (!binding.success || binding.data.expectedStatus !== 'under_review')) return reply.badRequest('A checked version, checksum and under_review status are required')
      const candidate = await db.marketplaceSubmission.findUnique({
        where: { id: request.params.id },
        select: { skillId: true },
      })
      if (!candidate) return reply.notFound('Marketplace submission not found')
      const result = await db.$transaction(async (transaction) => {
        if (variantsMode()) {
          const author = await transaction.skill.findUniqueOrThrow({ where: { id: candidate.skillId }, select: { authorId: true } })
          await lockUserMutation(transaction, author.authorId)
        }
        await lockSkillMutation(transaction, candidate.skillId)
        const submission = await transaction.marketplaceSubmission.findUnique({
          where: { id: request.params.id },
          include: {
            version: {
              select: {
                id: true,
                skillId: true,
                version: true,
                changelog: true,
                packageData: true,
              cardSha256: true,
                packageSha256: true,
                packageSize: true,
              },
            },
            skill: { select: { id: true, displayName: true, deletedAt: true } },
          },
        })
        if (!submission || submission.skill.deletedAt) return { outcome: 'not_found' } as const
        if (submission.status !== 'under_review') {
          return { outcome: 'not_under_review' } as const
        }
        if (agent && binding.success && !matchesReviewBinding(submission, binding.data)) return { outcome: 'version_mismatch' } as const
        if ((body.data.expectedVersionId && submission.versionId !== body.data.expectedVersionId)
          || (body.data.expectedPackageSha256 && submission.version.packageSha256?.toLowerCase() !== body.data.expectedPackageSha256.toLowerCase())) {
          return { outcome: 'version_mismatch' } as const
        }
        if (submission.version.skillId !== submission.skillId) return { outcome: 'version_mismatch' } as const
        if (containsSensitivePublicMetadata({
          skillName: submission.skillName,
          displayName: submission.displayName,
          description: submission.description,
          category: submission.category,
          labels: submission.labels,
          triggerScenarios: submission.triggerScenarios,
          compatibleAgents: submission.compatibleAgents,
          envDependencies: submission.envDependencies,
          sourceContent: submission.sourceContent,
          changelog: submission.version.changelog,
        })) return { outcome: 'metadata_invalid' } as const
        try {
          fullyInspectMarketplacePackage({
            ...submission,
            version: await withPackageBytes(request, submission.version),
          })
        } catch (error: unknown) {
          if (isPackageReviewLimitError(error)) return { outcome: 'package_review_too_large' } as const
          return { outcome: 'package_invalid' } as const
        }
        const now = new Date()
        const updated = await transaction.marketplaceSubmission.update({
          where: { id: submission.id },
          data: {
            status: 'approved',
            reviewerId: request.user.id,
            reviewNote: body.data.note,
            reviewedAt: now,
          },
          include: submissionInclude,
        })
        await publishApprovedListing(transaction, submission, now)
        await transaction.notification.create({
          data: {
            userId: submission.submittedById,
            type: 'marketplace_approved',
            payload: {
              skillId: submission.skillId,
              skillName: submission.skill.displayName,
              submissionId: submission.id,
              version: submission.version.version,
            },
          },
        })
        await auditAgentMutation(transaction, request, 'marketplace.review.approved', 'marketplace:review', submission.id)
        return { outcome: 'approved', submission: updated } as const
      })
      if (result.outcome === 'not_found') return reply.notFound('Marketplace submission not found')
      if (result.outcome === 'not_under_review') {
        return reply.conflict('Marketplace submission must be under review before approval')
      }
      if (result.outcome === 'version_mismatch') return reply.conflict('Submitted version does not belong to this Skill')
      if (result.outcome === 'metadata_invalid') {
        return reply.conflict('Submitted Skill contains sensitive public metadata')
      }
      if (result.outcome === 'package_invalid') {
        return reply.conflict('Submitted Skill package failed safety validation')
      }
      if (result.outcome === 'package_review_too_large') {
        return reply.code(413).send({
          error: 'Submitted Skill package is too large for complete Marketplace review',
        })
      }
      return submissionDto(result.submission)
    }
  )

  fastify.post<{ Params: { id: string } }>(
    `${adminPath}/submissions/:id/reject`,
    { preHandler: adminPreHandlers },
    async (request, reply) => {
      const body = RejectMarketplaceBody.safeParse(request.body)
      if (!body.success) return reply.badRequest(body.error.message)
      const binding = ReviewBinding.safeParse(request.body)
      if (agent && (!binding.success || binding.data.expectedStatus !== 'under_review')) return reply.badRequest('A checked version, checksum and under_review status are required')
      const reviewNote = body.data.reviewNote ?? body.data.reason
      if (!reviewNote) return reply.badRequest('reviewNote is required')
      const candidate = await db.marketplaceSubmission.findUnique({
        where: { id: request.params.id },
        select: { skillId: true },
      })
      if (!candidate) return reply.notFound('Marketplace submission not found')
      const result = await db.$transaction(async (transaction) => {
        await lockSkillMutation(transaction, candidate.skillId)
        const submission = await transaction.marketplaceSubmission.findUnique({
          where: { id: request.params.id },
          include: { skill: { select: { displayName: true, deletedAt: true } }, version: { select: { packageSha256: true } } },
        })
        if (!submission || submission.skill.deletedAt) return { outcome: 'not_found' } as const
        if (submission.status !== 'under_review') {
          return { outcome: 'not_under_review' } as const
        }
        if (agent && binding.success && !matchesReviewBinding(submission, binding.data)) return { outcome: 'not_under_review' } as const
        const now = new Date()
        const updated = await transaction.marketplaceSubmission.update({
          where: { id: submission.id },
          data: {
            status: 'rejected',
            reviewerId: request.user.id,
            reviewNote,
            reviewedAt: now,
          },
          include: submissionInclude,
        })
        const activeListing = await transaction.marketplaceListing.findFirst({
          where: { skillId: submission.skillId, withdrawnAt: null },
          select: { skillId: true },
        })
        await transaction.skill.update({
          where: { id: submission.skillId },
          data: { marketplaceStatus: activeListing ? 'approved' : 'rejected' },
        })
        await transaction.notification.create({
          data: {
            userId: submission.submittedById,
            type: 'marketplace_rejected',
            payload: {
              skillId: submission.skillId,
              skillName: submission.skill.displayName,
              submissionId: submission.id,
              versionId: submission.versionId,
              reviewNote,
            },
          },
        })
        await auditAgentMutation(transaction, request, 'marketplace.review.rejected', 'marketplace:review', submission.id)
        return { outcome: 'rejected', submission: updated } as const
      })
      if (result.outcome === 'not_found') return reply.notFound('Marketplace submission not found')
      if (result.outcome === 'not_under_review') {
        return reply.conflict('Marketplace submission must be under review before rejection')
      }
      return submissionDto(result.submission)
    }
  )

  if (!agent) {
  // Package downloads are intentionally public. The exact approved version is
  // pinned by the Listing, validated before every first cache hit, and bounded
  // per real client IP behind the trusted nginx hop.
  fastify.get<{ Params: { skillId: string } }>('/:skillId/package', async (request, reply) => {
    const retryAfter = packageReads.consume(
      `marketplace-package:${request.ip}`,
      config.MARKETPLACE_DOWNLOADS_PER_MINUTE,
      60_000
    )
    if (retryAfter !== null) {
      reply.header('Retry-After', String(retryAfter))
      return reply.tooManyRequests('Too many Marketplace package downloads. Try again later.')
    }
    const listing = await db.marketplaceListing.findFirst({
      where: {
        skillId: request.params.skillId,
        withdrawnAt: null,
        skill: { deletedAt: null },
        submission: { status: 'approved' },
      },
      include: {
        submission: { select: { id: true, skillName: true } },
        version: {
          select: {
            id: true,
            version: true,
            packageData: true,
              cardSha256: true,
            packageSha256: true,
            packageSize: true,
          },
        },
      },
    })
    if (!listing) return reply.notFound('Marketplace listing not found')
    return sendPackage(
      request,
      reply,
      listing.submission.skillName,
      listing.version,
      listing.skillId,
      listing.submissionId
    )
  })

  fastify.get<{ Params: { skillId: string } }>('/:skillId', async (request, reply) => {
    if (rejectRateLimited(
      reply,
      publicReads,
      `marketplace-public:${request.ip}`,
      MARKETPLACE_ABUSE_LIMITS.publicReadsPerMinute,
      60_000,
      'Too many Marketplace catalog requests. Try again later.'
    )) return
    const [listing, hotSkillIds] = await Promise.all([
      db.marketplaceListing.findFirst({
        where: {
          skillId: request.params.skillId,
          withdrawnAt: null,
          skill: { deletedAt: null },
          submission: { status: 'approved' },
        },
        include: listingInclude,
      }),
      loadHotSkillIds(),
    ])
    if (!listing) return reply.notFound('Marketplace listing not found')
    return marketplaceItem(listing, true, hotSkillIds)
  })
  }
}
