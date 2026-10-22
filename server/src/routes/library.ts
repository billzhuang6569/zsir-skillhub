import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma, type LibraryEntry, type SkillCard } from '@prisma/client'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { config } from '../config.js'
import { CatalogError, createCatalogVerifier, type CatalogVerifier } from '../lib/catalog.js'
import { db } from '../db.js'
import { SkillSourceUrlSchema } from '../lib/skill-source.js'
import { AttemptLimiter } from '../lib/attempt-limiter.js'
import { CardIntegrityError, readCardBytes } from '../lib/card-store.js'
import {
  lockSkillMutation,
  lockSkillTeamMutation,
  lockUserMutation,
} from '../lib/mutation-lock.js'
import { redactSensitiveContent } from '../lib/sensitive-content.js'
import { bindCloudAvatarToEntry } from '../lib/skill-avatars.js'
import {
  cardMetadata,
  CatalogAuthorshipError,
  ensureVersionCard,
  grantCard,
  prepareCard,
  registerCard,
  requireCardAuthorship,
  type CardGrantReason,
  type PreparedCard,
} from '../lib/skill-cards.js'
import { describeSkillPackage, SkillPackageValidationError } from '../lib/skill-package.js'
import { authMiddleware } from '../middleware/auth.js'
import { pruneQuickAccessAfterEntryDelete } from './library-organizer.js'
import {
  acceptVersionIntent, allocateVersion, entryHighWater, entryVersionMetadata, entryVersionMetadataBatch, type EntryVersionMetadata, lockEntryVersionSkills,
  receiptDto, receiptInclude, replayReceipt, requireVersion, VersionIntentSchema, VersionPolicyError,
  type Receipt,
} from '../lib/version-policy.js'
import {
  EnvDependenciesSchema,
  ImportCompatibleAgentsSchema,
  SkillNameSchema,
} from './skills.js'

const MAX_CARD_BYTES = 20 * 1024 * 1024
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const ResourceIdSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/)
const DeviceSchema = z.string().trim().min(1).max(80).optional()

const LibraryProfileSchema = z.object({
  sourceUrl: SkillSourceUrlSchema,
  displayName: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  category: z.string().trim().max(40).optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  triggerScenarios: z.array(z.string().trim().min(1).max(100)).max(8).default([]),
  compatibleAgents: ImportCompatibleAgentsSchema.default([]),
  envDependencies: EnvDependenciesSchema.default([]),
}).strict()

type LibraryProfile = z.infer<typeof LibraryProfileSchema>

const SourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('card'),
    cardSha256: Sha256Schema,
    // Display-only provenance for a copy the user modified; it grants nothing.
    provenance: z.object({
      sourceKind: z.enum(['local', 'marketplace', 'team']),
      sourceSkillId: ResourceIdSchema.optional(),
      sourceVersionId: ResourceIdSchema.optional(),
    }).strict().optional(),
  }).strict(),
  z.object({ kind: z.literal('marketplace'), skillId: ResourceIdSchema }).strict(),
  z.object({ kind: z.literal('catalog'), skillId: z.string().uuid(), version: z.string().min(1).max(40), packageSha256: Sha256Schema }).strict(),
  z.object({ kind: z.literal('team'), skillId: ResourceIdSchema, teamId: ResourceIdSchema }).strict(),
  z.object({ kind: z.literal('authored'), skillId: ResourceIdSchema }).strict(),
])

type LibrarySource = z.infer<typeof SourceSchema>

const CreateEntryBody = z.object({
  id: z.string().uuid(),
  name: SkillNameSchema,
  profile: LibraryProfileSchema,
  source: SourceSchema,
  migrationKey: z.string().regex(/^(authored|team|marketplace):[A-Za-z0-9-]{1,64}$/).optional(),
  versionIntent: VersionIntentSchema.optional(),
  device: DeviceSchema,
}).strict()

const UpdateEntryBody = z.object({
  versionIntent: VersionIntentSchema.optional(),
  baseRevision: z.number().int().min(1).optional(),
  name: SkillNameSchema.optional(),
  profile: LibraryProfileSchema.optional(),
  source: SourceSchema.optional(),
  device: DeviceSchema,
}).strict()

const RevisionBody = z.object({
  baseRevision: z.number().int().min(1).optional(),
  device: DeviceSchema,
}).strict()

const UploadCardBody = z.object({
  packageBase64: z.string().min(4).max(28_000_000),
  packageSha256: Sha256Schema,
}).strict()

type EntryWithCard = LibraryEntry & { card: SkillCard }

type ResolvedSource = {
  cardSha256: string
  sourceKind: 'local' | 'marketplace' | 'catalog' | 'team'
  sourceOrigin?: string | null
  sourceSkillId: string | null
  sourceVersionId: string | null
  authorSkillId: string | null
  grant: { reason: CardGrantReason; sourceRef: string } | null
}

type SourceOutcome =
  | { outcome: 'resolved'; source: ResolvedSource }
  | { outcome: 'card_unavailable' }
  | { outcome: 'source_unavailable' }
  | { outcome: 'source_changed' }

class LibraryRequestError extends Error {
  constructor(readonly statusCode: number, message: string, readonly entry?: EntryWithCard, readonly code?: string) {
    super(message)
  }
}

async function entryDto(entry: EntryWithCard, transaction?: Prisma.TransactionClient, metadata?: EntryVersionMetadata): Promise<Record<string, unknown>> {
  if (!transaction) return db.$transaction(async (tx) => entryDto(
    await tx.libraryEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { card: true } }), tx
  ), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  if (entry.deletedAt) {
    const profile = entry.profile as Record<string, unknown>
    return {
      id: entry.id,
      name: entry.name,
      displayName: typeof profile.displayName === 'string' ? profile.displayName : entry.name,
      revision: entry.revision,
      deletedAt: entry.deletedAt,
    }
  }
  return {
    ...(metadata ?? await entryVersionMetadata(transaction, entry)),
    id: entry.id,
    name: entry.name,
    profile: entry.profile,
    sourceKind: entry.sourceKind,
    sourceOrigin: entry.sourceOrigin,
    sourceSkillId: entry.sourceSkillId,
    sourceVersionId: entry.sourceVersionId,
    authorSkillId: entry.authorSkillId,
    migrationKey: entry.migrationKey,
    revision: entry.revision,
    updatedByDevice: entry.updatedByDevice,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    deletedAt: null,
    card: cardMetadata(entry.card),
  }
}

async function sendEntryConflict(reply: FastifyReply, error: LibraryRequestError): Promise<FastifyReply> {
  return reply.code(error.statusCode).send({
    error: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.entry ? { entry: await entryDto(error.entry) } : {}),
  })
}

async function entryResponse(entry: EntryWithCard, receipt?: Receipt | null): Promise<Record<string, unknown>> {
  return { ...await entryDto(entry), ...(receipt ? { acceptedVersionReceipt: receiptDto(receipt) } : {}) }
}

function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function createDigest(body: z.infer<typeof CreateEntryBody>): string {
  return canonicalDigest({
    schema: body.versionIntent ? 2 : 1,
    name: body.name,
    profile: body.profile,
    source: body.source,
    migrationKey: body.migrationKey ?? null,
    ...(body.versionIntent ? { versionIntent: body.versionIntent } : {}),
  })
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function decodeCardUpload(body: z.infer<typeof UploadCardBody>): Buffer {
  const { packageBase64, packageSha256 } = body
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(packageBase64) || packageBase64.length % 4 !== 0) {
    throw new LibraryRequestError(400, 'Invalid package encoding')
  }
  const data = Buffer.from(packageBase64, 'base64')
  if (data.length === 0 || data.length > MAX_CARD_BYTES) {
    throw new LibraryRequestError(400, 'Skill package must be between 1 byte and 20 MB')
  }
  if (createHash('sha256').update(data).digest('hex') !== packageSha256) {
    throw new LibraryRequestError(400, 'Skill package checksum mismatch')
  }
  return data
}

// Fresh uploads count before anything references them, so a burst of
// uploads cannot exceed the quota or fill the disk ahead of entry creation.
const UNREFERENCED_UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Storage charged to a user: cards they uploaded first that their own library
 * entries or author versions reference, plus their uploads of the last day.
 * Superseded sync revisions stop counting once they age out unreferenced.
 * `includeSha256` also charges a card about to be referenced.
 */
async function createdCardBytes(
  userId: string,
  client: Pick<Prisma.TransactionClient, 'skillCard'> = db,
  includeSha256?: string
): Promise<number> {
  const result = await client.skillCard.aggregate({
    where: {
      createdById: userId,
      OR: [
        { entries: { some: { userId } } },
        { receipts: { some: { entry: { userId } } } },
        { versions: { some: { skill: { authorId: userId } } } },
        { createdAt: { gte: new Date(Date.now() - UNREFERENCED_UPLOAD_GRACE_MS) } },
        ...(includeSha256 ? [{ sha256: includeSha256 }] : []),
      ],
    },
    _sum: { size: true },
  })
  return result._sum.size ?? 0
}

/** Referencing one's own aged, unreferenced upload must fit the quota again. */
async function requireReferenceQuota(
  transaction: Prisma.TransactionClient,
  userId: string,
  cardSha256: string
): Promise<void> {
  const card = await transaction.skillCard.findUnique({
    where: { sha256: cardSha256 },
    select: { createdById: true },
  })
  if (card?.createdById !== userId) return
  if (await createdCardBytes(userId, transaction, cardSha256) > config.SKILL_MAX_STORAGE_BYTES_PER_USER) {
    throw new LibraryRequestError(413, 'Skill storage quota exceeded')
  }
}

async function legacyStoredPackageBytes(
  userId: string,
  client: Pick<Prisma.TransactionClient, 'skillVersion'>
): Promise<number> {
  const result = await client.skillVersion.aggregate({
    where: { skill: { authorId: userId } },
    _sum: { packageSize: true },
  })
  return result._sum.packageSize ?? 0
}

/** The version a non-card source currently points at, read without locks. */
async function candidateSourceVersionId(userId: string, source: LibrarySource): Promise<string | null> {
  if (source.kind === 'card' || source.kind === 'catalog') return null
  if (source.kind === 'marketplace') {
    const listing = await db.marketplaceListing.findFirst({
      where: {
        skillId: source.skillId,
        withdrawnAt: null,
        skill: { deletedAt: null },
        submission: { status: 'approved' },
      },
      select: { versionId: true },
    })
    return listing?.versionId ?? null
  }
  const skill = await db.skill.findUnique({
    where: { id: source.skillId },
    select: { authorId: true, currentVersion: true, deletedAt: true },
  })
  if (!skill || skill.deletedAt) return null
  if (source.kind === 'authored' && skill.authorId !== userId) return null
  const version = await db.skillVersion.findUnique({
    where: { skillId_version: { skillId: source.skillId, version: skill.currentVersion } },
    select: { id: true },
  })
  return version?.id ?? null
}

/**
 * Re-checks access under the source locks and returns the card the user may
 * now reference. A grant created here is permanent: later withdrawal or team
 * removal does not revoke content the user already obtained.
 */
async function resolveSourceLocked(
  transaction: Prisma.TransactionClient,
  userId: string,
  source: LibrarySource,
  expectedVersionId: string | null
): Promise<SourceOutcome> {
  if (source.kind === 'catalog') {
    await requireCatalogUpload(transaction, userId, source.packageSha256)
    return { outcome: 'resolved', source: {
      cardSha256: source.packageSha256, sourceKind: 'catalog', sourceOrigin: config.CATALOG_ORIGIN,
      sourceSkillId: source.skillId, sourceVersionId: source.version, authorSkillId: null,
      grant: { reason: 'catalog', sourceRef: `catalog:${source.skillId}@${source.version}` },
    } }
  }
  if (source.kind === 'card') {
    const grant = await transaction.cardGrant.findUnique({
      where: { userId_cardSha256: { userId, cardSha256: source.cardSha256 } },
      select: { cardSha256: true, reason: true },
    })
    if (!grant) return { outcome: 'card_unavailable' }
    if (grant.reason === 'catalog') throw new CatalogAuthorshipError()
    return {
      outcome: 'resolved',
      source: {
        cardSha256: source.cardSha256,
        sourceKind: source.provenance?.sourceKind ?? 'local',
        sourceSkillId: source.provenance?.sourceSkillId ?? null,
        sourceVersionId: source.provenance?.sourceVersionId ?? null,
        authorSkillId: null,
        grant: null,
      },
    }
  }

  if (source.kind === 'marketplace') {
    await lockSkillMutation(transaction, source.skillId)
    const listing = await transaction.marketplaceListing.findFirst({
      where: {
        skillId: source.skillId,
        withdrawnAt: null,
        skill: { deletedAt: null },
        submission: { status: 'approved' },
      },
      select: { versionId: true, submissionId: true, version: { select: { cardSha256: true } } },
    })
    if (!listing) return { outcome: 'source_unavailable' }
    if (listing.versionId !== expectedVersionId || !listing.version.cardSha256) {
      return { outcome: 'source_changed' }
    }
    return {
      outcome: 'resolved',
      source: {
        cardSha256: listing.version.cardSha256,
        sourceKind: 'marketplace',
        sourceSkillId: source.skillId,
        sourceVersionId: listing.versionId,
        authorSkillId: null,
        grant: { reason: 'marketplace', sourceRef: `submission:${listing.submissionId}` },
      },
    }
  }

  if (source.kind === 'team') {
    await lockSkillTeamMutation(transaction, source.skillId, source.teamId)
    const [membership, share, skill] = await Promise.all([
      transaction.teamMember.findUnique({
        where: { teamId_userId: { teamId: source.teamId, userId } },
        select: { team: { select: { dissolvedAt: true } } },
      }),
      transaction.skillTeamShare.findUnique({
        where: { skillId_teamId: { skillId: source.skillId, teamId: source.teamId } },
        select: { skillId: true },
      }),
      transaction.skill.findUnique({
        where: { id: source.skillId },
        select: { currentVersion: true, deletedAt: true },
      }),
    ])
    if (!membership || membership.team.dissolvedAt || !share || !skill || skill.deletedAt) {
      return { outcome: 'source_unavailable' }
    }
    const version = await transaction.skillVersion.findUnique({
      where: { skillId_version: { skillId: source.skillId, version: skill.currentVersion } },
      select: { id: true, cardSha256: true },
    })
    if (!version || version.id !== expectedVersionId || !version.cardSha256) {
      return { outcome: 'source_changed' }
    }
    return {
      outcome: 'resolved',
      source: {
        cardSha256: version.cardSha256,
        sourceKind: 'team',
        sourceSkillId: source.skillId,
        sourceVersionId: version.id,
        authorSkillId: null,
        grant: { reason: 'team', sourceRef: `version:${version.id}` },
      },
    }
  }

  await lockSkillMutation(transaction, source.skillId)
  const skill = await transaction.skill.findUnique({
    where: { id: source.skillId },
    select: { authorId: true, currentVersion: true, deletedAt: true },
  })
  if (!skill || skill.deletedAt || skill.authorId !== userId) return { outcome: 'source_unavailable' }
  const version = await transaction.skillVersion.findUnique({
    where: { skillId_version: { skillId: source.skillId, version: skill.currentVersion } },
    select: { id: true, cardSha256: true },
  })
  if (!version || version.id !== expectedVersionId || !version.cardSha256) {
    return { outcome: 'source_changed' }
  }
  return {
    outcome: 'resolved',
    source: {
      cardSha256: version.cardSha256,
      sourceKind: 'local',
      sourceSkillId: null,
      sourceVersionId: version.id,
      authorSkillId: source.skillId,
      grant: { reason: 'authored', sourceRef: `version:${version.id}` },
    },
  }
}

function throwForSourceOutcome(outcome: Exclude<SourceOutcome, { outcome: 'resolved' }>): never {
  if (outcome.outcome === 'card_unavailable') {
    throw new LibraryRequestError(403, 'This Skill content is not available to your account')
  }
  if (outcome.outcome === 'source_unavailable') {
    throw new LibraryRequestError(403, 'The Skill source is no longer available to your account')
  }
  throw new LibraryRequestError(409, 'The Skill source changed; refresh and retry')
}

/** Prepares legacy version cards before locking, so transactions never touch disk. */
async function requireCatalogUpload(transaction: Pick<Prisma.TransactionClient, 'cardGrant'>, userId: string, sha256: string): Promise<void> {
  const grant = await transaction.cardGrant.findUnique({
    where: { userId_cardSha256: { userId, cardSha256: sha256 } }, select: { reason: true, uploadedAt: true, card: { select: { sha256: true } } },
  })
  if (!grant || (grant.reason !== 'upload' && !grant.uploadedAt) || grant.card.sha256 !== sha256) {
    throw new LibraryRequestError(403, 'Upload the original official package before binding its catalog source')
  }
}

function requireCatalogProfile(source: LibrarySource | undefined): void {
  if (source?.kind === 'catalog' && config.SKILLHUB_PROFILE !== 'selfhost') {
    throw new LibraryRequestError(400, 'Catalog sources are only supported on selfhost instances')
  }
}

function requireCatalogIdentity(entry: LibraryEntry, source: LibrarySource | undefined): void {
  if (!source) return
  if ((entry.sourceKind === 'catalog') !== (source.kind === 'catalog')
    || (source.kind === 'catalog' && (entry.sourceSkillId !== source.skillId || entry.sourceOrigin !== config.CATALOG_ORIGIN))) {
    throw new LibraryRequestError(409, 'Catalog source identity cannot be changed', undefined, 'CATALOG_SOURCE_IMMUTABLE')
  }
}

function requireAuthorable(entry: LibraryEntry): void {
  if (entry.sourceKind === 'catalog') throw new CatalogAuthorshipError()
}

async function prepareSourceVersion(userId: string, source: LibrarySource, verifyCatalog: CatalogVerifier): Promise<string | null> {
  requireCatalogProfile(source)
  if (source.kind === 'catalog') {
    await requireCatalogUpload(db, userId, source.packageSha256)
    await verifyCatalog(source)
    return null
  }
  const versionId = await candidateSourceVersionId(userId, source)
  if (source.kind === 'card') return null
  if (!versionId) throw new LibraryRequestError(403, 'The Skill source is no longer available to your account')
  const cardSha256 = await ensureVersionCard(versionId)
  if (!cardSha256) throw new LibraryRequestError(409, 'The Skill source has no installable package')
  return versionId
}

async function lockedOwnedEntry(
  transaction: Prisma.TransactionClient,
  userId: string,
  entryId: string
): Promise<EntryWithCard> {
  await lockUserMutation(transaction, userId)
  const entry = await transaction.libraryEntry.findUnique({
    where: { id: entryId },
    include: { card: true },
  })
  if (!entry || entry.userId !== userId) throw new LibraryRequestError(404, 'Library entry not found')
  return entry
}

function requireBaseRevision(entry: EntryWithCard, baseRevision: number | undefined): void {
  if (baseRevision === undefined) {
    throw new LibraryRequestError(428, 'baseRevision is required', undefined, 'LIBRARY_BASE_REVISION_REQUIRED')
  }
  if (entry.revision !== baseRevision) {
    throw new LibraryRequestError(409, 'Library entry revision conflict', entry, 'LIBRARY_REVISION_CONFLICT')
  }
}

async function activeEntryLimitReached(
  transaction: Prisma.TransactionClient,
  userId: string
): Promise<boolean> {
  const active = await transaction.libraryEntry.count({ where: { userId, deletedAt: null } })
  return active >= config.SKILL_MAX_PER_USER
}

export const libraryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', authMiddleware)
  const verifyCatalog = createCatalogVerifier(config.CATALOG_ORIGIN)
  const cardUploads = new AttemptLimiter()
  const cardDownloads = new AttemptLimiter()

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
    reply.header('Retry-After', String(retryAfter)).code(429).send({ error: message })
    return true
  }

  async function grantedCard(userId: string, sha256: string): Promise<SkillCard | null> {
    const grant = await db.cardGrant.findUnique({
      where: { userId_cardSha256: { userId, cardSha256: sha256 } },
      select: { card: true },
    })
    return grant?.card ?? null
  }

  async function handleError(request: FastifyRequest, reply: FastifyReply, error: unknown): Promise<FastifyReply> {
    if (error instanceof CatalogError || error instanceof CatalogAuthorshipError) return reply.code(error.statusCode).send({ code: error.code, error: error.message })
    if (error instanceof VersionPolicyError) {
      const params = request.params as { id?: unknown }
      const entry = error.statusCode === 409 && typeof params?.id === 'string'
        ? await db.libraryEntry.findFirst({ where: { id: params.id, userId: request.user.id }, include: { card: true } }) : null
      return reply.code(error.statusCode).send({ error: error.message, code: error.code, ...(entry ? { entry: await entryDto(entry) } : {}) })
    }
    if (error instanceof LibraryRequestError) return sendEntryConflict(reply, error)
    if (error instanceof SkillPackageValidationError) {
      return reply.code(400).send({ error: error.message })
    }
    if (error instanceof CardIntegrityError) {
      request.log.error({ error: error.message }, 'Skill card integrity failure')
      return reply.code(500).send({ error: 'Stored Skill content failed its integrity check' })
    }
    throw error
  }

  // GET /api/library — every entry of the account, bounded by the total record limit.
  fastify.get('/library', async (request, reply): Promise<FastifyReply> => {
    const entries = await db.$transaction(async (tx) => {
      const rows = await tx.libraryEntry.findMany({
      where: { userId: request.user.id },
      include: { card: true },
      orderBy: { createdAt: 'asc' },
      take: config.SKILL_MAX_PER_USER * 20,
      })
      const metadata = await entryVersionMetadataBatch(tx, rows.filter((row) => !row.deletedAt))
      return Promise.all(rows.map((row) => entryDto(row, tx, metadata.get(row.id))))
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 })
    return reply.send({ entries })
  })

  fastify.get<{ Params: { id: string } }>('/library/:id/receipts', async (request, reply): Promise<FastifyReply> => {
    try {
      const result = await db.$transaction(async (tx) => {
        const entry = await tx.libraryEntry.findFirst({ where: { id: request.params.id, userId: request.user.id } })
        if (!entry) throw new LibraryRequestError(404, 'Library entry not found')
        const receipts = await tx.libraryEntryVersion.findMany({ where: { entryId: entry.id }, include: receiptInclude, orderBy: [{ label: 'asc' }, { id: 'asc' }], take: 1001 })
        if (receipts.length > 1000) throw new VersionPolicyError('VERSION_INTEGRITY_ERROR', 'Version receipt capacity exceeded', 500)
        const { version: _current, ...metadata } = await entryVersionMetadata(tx, entry)
        return { entryId: entry.id, entryRevision: entry.revision, ...metadata, receipts: receipts.map(receiptDto) }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
      return reply.send(result)
    } catch (error: unknown) { return handleError(request, reply, error) }
  })

  // POST /api/cards — upload complete bytes; the only way to obtain an `upload` grant.
  fastify.post<{ Body: unknown }>('/cards', { bodyLimit: 30 * 1024 * 1024 }, async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const userId = request.user.id
    if (rejectRateLimited(
      reply,
      cardUploads,
      `card-upload:${userId}`,
      config.LIBRARY_CARD_UPLOADS_PER_HOUR,
      60 * 60 * 1000,
      'Too many Skill uploads. Try again later.'
    )) return reply
    const body = UploadCardBody.safeParse(request.body)
    if (!body.success) return reply.badRequest(body.error.message)
    try {
      const data = decodeCardUpload(body.data)
      const existing = await db.skillCard.findUnique({
        where: { sha256: body.data.packageSha256 },
        select: { sha256: true },
      })
      // Checked before touching disk so over-quota uploads do not accumulate files.
      if (!existing && await createdCardBytes(userId) + data.length > config.SKILL_MAX_STORAGE_BYTES_PER_USER) {
        return reply.code(413).send({ error: 'Skill storage quota exceeded' })
      }
      const card: PreparedCard = await prepareCard(data)
      const created = await db.$transaction(async (transaction) => {
        await lockUserMutation(transaction, userId)
        const row = await transaction.skillCard.findUnique({
          where: { sha256: card.sha256 },
          select: { sha256: true },
        })
        if (!row) {
          if (await createdCardBytes(userId, transaction) + card.size > config.SKILL_MAX_STORAGE_BYTES_PER_USER) {
            throw new LibraryRequestError(413, 'Skill storage quota exceeded')
          }
          await registerCard(transaction, card, userId)
        }
        await grantCard(transaction, userId, card.sha256, 'upload', null)
        return !row
      })
      return reply.code(created ? 201 : 200).send(cardMetadata(card))
    } catch (error: unknown) {
      return handleError(request, reply, error)
    }
  })

  fastify.get<{ Params: { sha256: string } }>(
    '/cards/:sha256',
    async (request, reply): Promise<FastifyReply> => {
      const userId = request.user.id
      if (rejectRateLimited(
        reply,
        cardDownloads,
        `card-download:${userId}`,
        config.LIBRARY_CARD_DOWNLOADS_PER_MINUTE,
        60_000,
        'Too many Skill downloads. Try again later.'
      )) return reply
      if (!Sha256Schema.safeParse(request.params.sha256).success) return reply.notFound()
      // Without a grant the card is indistinguishable from a missing one.
      const card = await grantedCard(userId, request.params.sha256)
      if (!card) return reply.notFound()
      try {
        const data = await readCardBytes(card.storageKey, card.sha256, card)
        return reply
          .header('Cache-Control', 'no-store')
          .header('Content-Type', 'application/zip')
          .header('X-Checksum-Sha256', card.sha256)
          .header('X-Content-Hash', card.contentHash)
          .send(data)
      } catch (error: unknown) {
        return handleError(request, reply, error)
      }
    }
  )

  fastify.get<{ Params: { sha256: string } }>(
    '/cards/:sha256/meta',
    async (request, reply): Promise<FastifyReply> => {
      if (!Sha256Schema.safeParse(request.params.sha256).success) return reply.notFound()
      const card = await grantedCard(request.user.id, request.params.sha256)
      if (!card) return reply.notFound()
      return reply.send(cardMetadata(card))
    }
  )

  // POST /api/library — idempotent by client id; migration keys return the existing entry.
  fastify.post<{ Body: unknown }>('/library', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const userId = request.user.id
    const body = CreateEntryBody.safeParse(request.body)
    if (!body.success) return reply.badRequest(body.error.message)
    const requestDigest = createDigest(body.data)
    try {
      requireCatalogProfile(body.data.source)
      if (body.data.source.kind === 'catalog' && body.data.migrationKey) {
        throw new LibraryRequestError(400, 'Catalog sources do not use legacy migration keys')
      }
      // A retry must find its entry even if the source has since changed or
      // disappeared, so existing ids and migration keys are answered first.
      const replay = await db.libraryEntry.findFirst({
        where: {
          OR: [
            { id: body.data.id },
            ...(body.data.migrationKey ? [{ userId, migrationKey: body.data.migrationKey }] : []),
          ],
        },
        include: { card: true },
      })
      if (replay?.id === body.data.id) {
        if (replay.userId !== userId) return reply.code(409).send({ error: 'Library entry id is already in use' })
        if (replay.requestDigest === requestDigest) {
          const receipt = await db.$transaction(async (tx) => {
            const current = await lockedOwnedEntry(tx, userId, replay.id)
            return replayReceipt(tx, current, body.data.versionIntent)
          })
          return reply.send(await entryResponse(replay, receipt))
        }
        return sendEntryConflict(reply, new LibraryRequestError(409, 'Library entry already exists with different content', replay))
      }
      if (replay && replay.userId === userId && body.data.migrationKey && replay.migrationKey === body.data.migrationKey) {
        return reply.send(await entryDto(replay))
      }
      const catalogIdentity = body.data.source.kind === 'catalog'
        ? { userId, sourceKind: 'catalog', sourceOrigin: config.CATALOG_ORIGIN, sourceSkillId: body.data.source.skillId, deletedAt: null } : null
      if (catalogIdentity) {
        const existing = await db.libraryEntry.findFirst({ where: catalogIdentity, include: { card: true } })
        if (existing) return reply.send(await entryDto(existing))
      }
      const expectedVersionId = await prepareSourceVersion(userId, body.data.source, verifyCatalog)
      const result = await db.$transaction(async (transaction) => {
        await lockUserMutation(transaction, userId)
        const sameId = await transaction.libraryEntry.findUnique({
          where: { id: body.data.id },
          include: { card: true },
        })
        if (sameId) {
          if (sameId.userId !== userId) throw new LibraryRequestError(409, 'Library entry id is already in use')
          if (sameId.requestDigest === requestDigest) return { status: 200, entry: sameId, receipt: await replayReceipt(transaction, sameId, body.data.versionIntent) }
          throw new LibraryRequestError(409, 'Library entry already exists with different content', sameId)
        }
        if (body.data.migrationKey) {
          const migrated = await transaction.libraryEntry.findUnique({
            where: { userId_migrationKey: { userId, migrationKey: body.data.migrationKey } },
            include: { card: true },
          })
          if (migrated) return { status: 200, entry: migrated }
        }
        if (catalogIdentity) {
          const existing = await transaction.libraryEntry.findFirst({ where: catalogIdentity, include: { card: true } })
          if (existing) return { status: 200, entry: existing }
        }
        if (await activeEntryLimitReached(transaction, userId)) {
          throw new LibraryRequestError(409, 'Library entry limit reached')
        }
        const total = await transaction.libraryEntry.count({ where: { userId } })
        if (total >= config.SKILL_MAX_PER_USER * 20) {
          throw new LibraryRequestError(409, 'Library record limit reached')
        }
        await lockEntryVersionSkills(transaction, { authorSkillId: null }, body.data.versionIntent, body.data.source.kind === 'card' || body.data.source.kind === 'catalog' ? undefined : body.data.source.skillId, body.data.source.kind === 'team' ? body.data.source.teamId : undefined)
        const resolved = await resolveSourceLocked(transaction, userId, body.data.source, expectedVersionId)
        if (resolved.outcome !== 'resolved') throwForSourceOutcome(resolved)
        const source = resolved.source
        const sourceVersion = source.sourceKind !== 'catalog' && source.sourceVersionId ? await transaction.skillVersion.findUnique({ where: { id: source.sourceVersionId }, select: { sourceUrl: true } }) : null
        await requireReferenceQuota(transaction, userId, source.cardSha256)
        if (source.grant) {
          await grantCard(transaction, userId, source.cardSha256, source.grant.reason, source.grant.sourceRef)
        }
        let entry = await transaction.libraryEntry.create({
          data: {
            id: body.data.id,
            userId,
            cardSha256: source.cardSha256,
            name: body.data.name,
            profile: { ...body.data.profile, sourceUrl: body.data.profile.sourceUrl === undefined ? sourceVersion?.sourceUrl ?? null : body.data.profile.sourceUrl },
            sourceKind: source.sourceKind,
            sourceOrigin: source.sourceOrigin ?? null,
            sourceSkillId: source.sourceSkillId,
            sourceVersionId: source.sourceVersionId,
            authorSkillId: source.authorSkillId,
            migrationKey: body.data.migrationKey ?? null,
            requestDigest,
            updatedByDevice: body.data.device ?? null,
          },
          include: { card: true },
        })
        const receipt = await acceptVersionIntent(transaction, entry, entry.cardSha256, body.data.versionIntent)
        if (receipt) {
          const formal = receipt.formalVersionId && body.data.profile.sourceUrl === undefined
            ? await transaction.skillVersion.findUnique({ where: { id: receipt.formalVersionId }, select: { sourceUrl: true } }) : null
          entry = await transaction.libraryEntry.update({ where: { id: entry.id }, data: {
            currentVersionReceiptId: receipt.id,
            ...(formal ? { profile: { ...body.data.profile, sourceUrl: formal.sourceUrl } } : {}),
          }, include: { card: true } })
        }
        return { status: 201, entry, receipt }
      })
      return reply.code(result.status).send(await entryResponse(result.entry, 'receipt' in result ? result.receipt : null))
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        return reply.code(409).send({ error: 'Library entry id is already in use' })
      }
      return handleError(request, reply, error)
    }
  })

  // PUT /api/library/:id — conditional update of the content pointer and Profile.
  fastify.put<{ Params: { id: string }; Body: unknown }>('/library/:id', async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
    const userId = request.user.id
    const body = UpdateEntryBody.safeParse(request.body)
    if (!body.success) return reply.badRequest(body.error.message)
    try {
      requireCatalogProfile(body.data.source)
      const candidate = await db.libraryEntry.findUnique({ where: { id: request.params.id } })
      if (!candidate || candidate.userId !== userId) return reply.notFound('Library entry not found')
      requireCatalogIdentity(candidate, body.data.source)
      if (body.data.versionIntent?.kind === 'save') {
        const replay = await db.$transaction(async (tx) => {
          const entry = await lockedOwnedEntry(tx, userId, request.params.id)
          requireCatalogIdentity(entry, body.data.source)
          await lockEntryVersionSkills(tx, entry)
          const receipt = await replayReceipt(tx, entry, body.data.versionIntent)
          return receipt ? { entry, receipt } : null
        })
        if (replay) return reply.send(await entryResponse(replay.entry, replay.receipt))
      }
      const expectedVersionId = body.data.source
        ? await prepareSourceVersion(userId, body.data.source, verifyCatalog)
        : null
      const result = await db.$transaction(async (transaction) => {
        const current = await lockedOwnedEntry(transaction, userId, request.params.id)
        requireCatalogIdentity(current, body.data.source)
        await lockEntryVersionSkills(transaction, current, body.data.versionIntent, body.data.source && body.data.source.kind !== 'card' && body.data.source.kind !== 'catalog' ? body.data.source.skillId : undefined, body.data.source?.kind === 'team' ? body.data.source.teamId : undefined)
        const replay = await replayReceipt(transaction, current, body.data.versionIntent)
        if (replay) return { entry: current, receipt: replay }
        requireBaseRevision(current, body.data.baseRevision)
        if (current.deletedAt) throw new LibraryRequestError(409, 'Library entry was deleted', current)
        let sourceFields: Partial<ResolvedSource> = {}
        if (body.data.source) {
          const resolved = await resolveSourceLocked(transaction, userId, body.data.source, expectedVersionId)
          if (resolved.outcome !== 'resolved') throwForSourceOutcome(resolved)
          const source = resolved.source
          if (source.cardSha256 !== current.cardSha256) {
            await requireReferenceQuota(transaction, userId, source.cardSha256)
          }
          if (source.grant) {
            await grantCard(transaction, userId, source.cardSha256, source.grant.reason, source.grant.sourceRef)
          }
          sourceFields = body.data.source.kind === 'card' && !body.data.source.provenance
            ? { cardSha256: source.cardSha256 }
            : {
              cardSha256: source.cardSha256,
              sourceKind: source.sourceKind,
              sourceOrigin: source.sourceOrigin ?? null,
              sourceSkillId: source.sourceSkillId,
              sourceVersionId: source.sourceVersionId,
              ...(source.authorSkillId ? { authorSkillId: source.authorSkillId } : {}),
            }
        }
        const targetCard = sourceFields.cardSha256 ?? current.cardSha256
        if (body.data.versionIntent) await requireReferenceQuota(transaction, userId, targetCard)
        const priorFormal = body.data.versionIntent?.kind === 'formal' && current.currentVersionReceiptId
          ? await transaction.libraryEntryVersion.findUnique({ where: { id: current.currentVersionReceiptId }, select: { formalVersionId: true } }) : null
        const receipt = await acceptVersionIntent(transaction, { ...current, authorSkillId: sourceFields.authorSkillId ?? current.authorSkillId }, targetCard, body.data.versionIntent)
        const incomingVersionId = (receipt?.id !== current.currentVersionReceiptId ? receipt?.formalVersionId : null)
          ?? (sourceFields.sourceKind !== 'catalog' && sourceFields.sourceVersionId !== current.sourceVersionId ? sourceFields.sourceVersionId : null)
        const incomingVersion = incomingVersionId ? await transaction.skillVersion.findUnique({ where: { id: incomingVersionId }, select: { sourceUrl: true } }) : null
        const oldProfile = LibraryProfileSchema.parse(current.profile)
        const profile = body.data.profile || incomingVersion ? {
          ...(body.data.profile ?? oldProfile),
          sourceUrl: body.data.profile?.sourceUrl === undefined ? incomingVersion ? incomingVersion.sourceUrl : oldProfile.sourceUrl ?? null : body.data.profile.sourceUrl,
        } : undefined
        const unchanged = targetCard === current.cardSha256 && (!body.data.name || body.data.name === current.name)
          && (!profile || canonicalDigest(profile) === canonicalDigest(current.profile))
          && (receipt?.id ?? null) === current.currentVersionReceiptId
          && Object.entries(sourceFields).every(([key, value]) => current[key as keyof typeof current] === value)
          && (body.data.versionIntent?.kind !== 'formal' || priorFormal?.formalVersionId === receipt?.formalVersionId)
        if (unchanged) return { entry: current, receipt: body.data.versionIntent ? receipt : null }
        const entry = await transaction.libraryEntry.update({
          where: { id: current.id },
          data: {
            ...(body.data.name ? { name: body.data.name } : {}),
            ...(profile ? { profile } : {}),
            ...(sourceFields.cardSha256 ? { cardSha256: sourceFields.cardSha256 } : {}),
            ...(sourceFields.sourceKind ? { sourceKind: sourceFields.sourceKind } : {}),
            ...('sourceOrigin' in sourceFields ? { sourceOrigin: sourceFields.sourceOrigin } : {}),
            ...('sourceSkillId' in sourceFields ? { sourceSkillId: sourceFields.sourceSkillId } : {}),
            ...('sourceVersionId' in sourceFields ? { sourceVersionId: sourceFields.sourceVersionId } : {}),
            ...(sourceFields.authorSkillId ? { authorSkillId: sourceFields.authorSkillId } : {}),
            currentVersionReceiptId: receipt?.id ?? null,
            revision: { increment: 1 },
            updatedByDevice: body.data.device ?? null,
          },
          include: { card: true },
        })
        return { entry, receipt: body.data.versionIntent ? receipt : null }
      })
      return reply.send(await entryResponse(result.entry, result.receipt))
    } catch (error: unknown) {
      return handleError(request, reply, error)
    }
  })

  // DELETE /api/library/:id?baseRevision=N — account-wide, recoverable removal.
  fastify.delete<{ Params: { id: string }; Querystring: { baseRevision?: string; device?: string } }>(
    '/library/:id',
    async (request, reply): Promise<FastifyReply> => {
      const userId = request.user.id
      const rawRevision = request.query.baseRevision
      const body = RevisionBody.safeParse({
        baseRevision: rawRevision === undefined ? undefined : Number(rawRevision),
        device: request.query.device,
      })
      if (!body.success) return reply.badRequest(body.error.message)
      try {
        const entry = await db.$transaction(async (transaction) => {
          const current = await lockedOwnedEntry(transaction, userId, request.params.id)
          requireBaseRevision(current, body.data.baseRevision)
          if (current.deletedAt) throw new LibraryRequestError(409, 'Library entry was already deleted', current)
          const deleted = await transaction.libraryEntry.update({
            where: { id: current.id },
            data: {
              deletedAt: new Date(),
              revision: { increment: 1 },
              updatedByDevice: body.data.device ?? null,
            },
            include: { card: true },
          })
          await pruneQuickAccessAfterEntryDelete(transaction, userId, current.id)
          return deleted
        })
        return reply.send(await entryDto(entry))
      } catch (error: unknown) {
        return handleError(request, reply, error)
      }
    }
  )

  fastify.post<{ Params: { id: string } }>(
    '/library/:id/restore',
    async (request, reply): Promise<FastifyReply> => {
      const userId = request.user.id
      const body = RevisionBody.safeParse(request.body ?? {})
      if (!body.success) return reply.badRequest(body.error.message)
      try {
        const entry = await db.$transaction(async (transaction) => {
          const current = await lockedOwnedEntry(transaction, userId, request.params.id)
          requireBaseRevision(current, body.data.baseRevision)
          if (!current.deletedAt) throw new LibraryRequestError(409, 'Library entry is not deleted', current)
          if (current.sourceKind === 'catalog' && await transaction.libraryEntry.findFirst({ where: {
            userId, sourceKind: 'catalog', sourceOrigin: current.sourceOrigin, sourceSkillId: current.sourceSkillId, deletedAt: null,
          } })) throw new LibraryRequestError(409, 'This catalog Skill already has an active library entry')
          if (await activeEntryLimitReached(transaction, userId)) {
            throw new LibraryRequestError(409, 'Library entry limit reached')
          }
          return transaction.libraryEntry.update({
            where: { id: current.id },
            data: {
              deletedAt: null,
              revision: { increment: 1 },
              updatedByDevice: body.data.device ?? null,
            },
            include: { card: true },
          })
        })
        return reply.send(await entryDto(entry))
      } catch (error: unknown) {
        return handleError(request, reply, error)
      }
    }
  )

  // POST /api/library/:id/author-asset — idempotently publish an entry as the user's own Skill.
  fastify.post<{ Params: { id: string }; Body: unknown }>(
    '/library/:id/author-asset',
    async (request: FastifyRequest<{ Params: { id: string }; Body: unknown }>, reply: FastifyReply): Promise<FastifyReply> => {
      const userId = request.user.id
      const body = RevisionBody.safeParse(request.body ?? {})
      if (!body.success) return reply.badRequest(body.error.message)
      try {
        const entry = await db.libraryEntry.findUnique({
          where: { id: request.params.id },
          include: { card: true },
        })
        if (!entry || entry.userId !== userId) return reply.notFound('Library entry not found')
        requireAuthorable(entry)
        await requireCardAuthorship(db, entry.userId, entry.cardSha256)
        if (entry.deletedAt) return reply.conflict('Library entry was deleted')
        if (entry.authorSkillId) {
          const existing = await db.skill.findUnique({
            where: { id: entry.authorSkillId },
            select: { id: true, name: true, currentVersion: true, authorId: true, deletedAt: true },
          })
          if (existing && existing.authorId === userId && !existing.deletedAt) {
            return reply.send({
              skill: { id: existing.id, name: existing.name, currentVersion: existing.currentVersion },
              entry: await entryDto(entry),
              created: false,
            })
          }
        }
        // Based on server facts, not client provenance: content that is a
        // version of another author's Skill stays that author's.
        const foreignVersion = await db.skillVersion.findFirst({
          where: { cardSha256: entry.cardSha256, skill: { authorId: { not: userId } } },
          select: { id: true },
        })
        if (foreignVersion) {
          return reply.conflict('An unmodified Marketplace or team Skill cannot become your own asset')
        }
        const data = await readCardBytes(entry.card.storageKey, entry.card.sha256, entry.card)
        const described = describeSkillPackage(data)
        const parsedProfile = LibraryProfileSchema.safeParse(entry.profile)
        if (!parsedProfile.success) return reply.conflict('Library entry Profile is invalid; update it first')
        const profile: LibraryProfile = parsedProfile.data
        const sourceContent = redactSensitiveContent(described.skillMd).content

        const result = await db.$transaction(async (transaction) => {
          const current = await lockedOwnedEntry(transaction, userId, entry.id)
          requireAuthorable(current)
          await requireCardAuthorship(transaction, current.userId, current.cardSha256)
          if (current.deletedAt) throw new LibraryRequestError(409, 'Library entry was deleted', current)
          if (current.revision !== entry.revision || (body.data.baseRevision !== undefined && current.revision !== body.data.baseRevision)
            || current.cardSha256 !== entry.cardSha256 || current.authorSkillId !== entry.authorSkillId) {
            throw new LibraryRequestError(409, 'Library entry changed; retry', current)
          }
          const [activeSkills, allSkills, storedBytes, sameName] = await Promise.all([
            transaction.skill.count({ where: { authorId: userId, deletedAt: null } }),
            transaction.skill.count({ where: { authorId: userId } }),
            legacyStoredPackageBytes(userId, transaction),
            transaction.skill.findFirst({
              where: { authorId: userId, name: current.name, deletedAt: null },
              select: { id: true },
            }),
          ])
          if (activeSkills >= config.SKILL_MAX_PER_USER) throw new LibraryRequestError(409, 'Skill account limit reached')
          if (allSkills >= config.SKILL_MAX_PER_USER * 20) throw new LibraryRequestError(409, 'Skill recycle bin limit reached')
          if (storedBytes + data.length > config.SKILL_MAX_STORAGE_BYTES_PER_USER) {
            throw new LibraryRequestError(413, 'Skill storage quota exceeded')
          }
          if (sameName) throw new LibraryRequestError(409, 'A Skill with this name already exists in your asset library')
          const currentReceipt = current.currentVersionReceiptId ? await transaction.libraryEntryVersion.findUnique({ where: { id: current.currentVersionReceiptId } }) : null
          if (currentReceipt?.formalVersionId) throw new LibraryRequestError(409, 'An upstream version cannot be rebound as your own asset', current)
          const highWater = await entryHighWater(transaction, current)
          const version = currentReceipt?.label ?? allocateVersion(highWater)
          const nextHighWater = Math.max(highWater, requireVersion(version))
          const skill = await transaction.skill.create({
            data: {
              name: current.name,
              displayName: profile.displayName,
              description: profile.description ?? null,
              sourceUrl: profile.sourceUrl ?? null,
              category: profile.category ?? null,
              labels: profile.labels,
              triggerScenarios: profile.triggerScenarios,
              compatibleAgents: profile.compatibleAgents,
              envDependencies: profile.envDependencies,
              sourceContent,
              currentVersion: version,
              versionHighWater: nextHighWater,
              authorId: userId,
              versions: {
                create: {
                  version,
                  changelog: '从我的 Skill 发布',
                  profileSnapshotVersion: 1,
                  skillName: current.name,
                  displayName: profile.displayName,
                  description: profile.description ?? null,
                  sourceUrl: profile.sourceUrl ?? null,
                  category: profile.category ?? null,
                  labels: profile.labels,
                  triggerScenarios: profile.triggerScenarios,
                  compatibleAgents: profile.compatibleAgents,
                  envDependencies: profile.envDependencies,
                  sourceContent,
                  // Dual-written during the transition so a rollback keeps serving it.
                  packageData: data,
                  packageSha256: current.cardSha256,
                  packageSize: data.length,
                  cardSha256: current.cardSha256,
                },
              },
            },
            select: { id: true, name: true, currentVersion: true, versions: { select: { id: true } } },
          })
          const formalVersionId = skill.versions[0]!.id
          const receipt = currentReceipt
            ? await transaction.libraryEntryVersion.update({ where: { id: currentReceipt.id }, data: { formalVersionId } })
            : await transaction.libraryEntryVersion.create({ data: { entryId: current.id, label: version, cardSha256: current.cardSha256, formalVersionId } })
          await grantCard(transaction, userId, current.cardSha256, 'authored', `skill:${skill.id}`)
          const updated = await transaction.libraryEntry.update({
            where: { id: current.id },
            data: {
              authorSkillId: skill.id,
              currentVersionReceiptId: receipt.id,
              versionHighWater: nextHighWater,
              revision: { increment: 1 },
              updatedByDevice: body.data.device ?? null,
            },
            include: { card: true },
          })
          return { skill, entry: updated }
        })
        // Bind the avatar the device registered under this entry id; never
        // create one here (no device identity → it could duplicate a local task).
        await bindCloudAvatarToEntry(userId, result.skill.id, result.entry.id)
          .catch(() => { request.log.warn('Skill avatar binding deferred') })
        return reply.code(201).send({ skill: result.skill, entry: await entryDto(result.entry), created: true })
      } catch (error: unknown) {
        if (isUniqueConstraintError(error)) {
          return reply.conflict('A Skill with this name already exists in your asset library')
        }
        return handleError(request, reply, error)
      }
    }
  )
}
