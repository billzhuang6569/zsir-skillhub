import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { db } from '../db.js'
import { describeSkillPackage, SkillPackageValidationError } from './skill-package.js'
import { CardIntegrityError, cardStorageProvider, cardStorageNamespace, readCardBytes, storeCardBytes } from './card-store.js'
import { ObjectMissingError } from '../providers/object-storage.js'
import type { ObjectStorage } from '../providers/object-storage.js'

type CardClient = Pick<Prisma.TransactionClient, '$executeRaw' | 'cardGrant'>

export class CatalogAuthorshipError extends Error {
  readonly statusCode = 409
  readonly code = 'CATALOG_NOT_AUTHORED'
  constructor() { super('来自官方商店的 Skill 不能作为自己的作品发布或共享') }
}

export async function requireCardAuthorship(client: Pick<Prisma.TransactionClient, 'cardGrant'>, userId: string, cardSha256: string): Promise<void> {
  const grant = await client.cardGrant.findUnique({ where: { userId_cardSha256: { userId, cardSha256 } }, select: { reason: true } })
  if (grant?.reason === 'catalog') throw new CatalogAuthorshipError()
}

export type CardGrantReason = 'upload' | 'marketplace' | 'catalog' | 'team' | 'authored'

export type PreparedCard = {
  sha256: string
  size: number
  contentHash: string
  executablePaths: string[]
  storageKey: string
  storageProvider: ObjectStorage['provider']
  storageNamespace: string | null
  skillMd: string
}

export type CardMetadata = {
  sha256: string
  size: number
  contentHash: string
  executablePaths: string[]
}

/**
 * Validates package bytes, derives the cross-platform content identity, and
 * durably writes the immutable file. Database rows may reference the card
 * only after this resolves, so a failed transaction can at most leave an
 * unreferenced file behind.
 */
export async function prepareCard(data: Buffer): Promise<PreparedCard> {
  const described = describeSkillPackage(data)
  const sha256 = createHash('sha256').update(data).digest('hex')
  const storageKey = await storeCardBytes(data, sha256)
  return {
    sha256,
    size: data.length,
    contentHash: described.contentHash,
    executablePaths: described.executablePaths,
    storageKey,
    storageProvider: cardStorageProvider(),
    storageNamespace: cardStorageNamespace(),
    skillMd: described.skillMd,
  }
}

/** Inserts the card row once; the first uploader keeps the storage attribution. */
export async function registerCard(
  client: CardClient,
  card: Omit<PreparedCard, 'skillMd'>,
  createdById: string | null
): Promise<void> {
  // ON CONFLICT keeps concurrent first uploads from aborting the transaction.
  await client.$executeRaw`
    INSERT INTO "skill_cards" ("sha256", "contentHash", "executablePaths", "size", "storageKey", "storageProvider", "storageNamespace", "createdById")
    VALUES (${card.sha256}, ${card.contentHash}, ${JSON.stringify(card.executablePaths)}::jsonb,
            ${card.size}, ${card.storageKey}, ${card.storageProvider}, ${card.storageNamespace}, ${createdById})
    ON CONFLICT ("sha256") DO NOTHING
  `
}

export async function grantCard(
  client: CardClient,
  userId: string,
  cardSha256: string,
  reason: CardGrantReason,
  sourceRef: string | null
): Promise<void> {
  // All author-creating callers run in a transaction; reject before it can commit.
  if (reason === 'authored') await requireCardAuthorship(client, userId, cardSha256)
  await client.$executeRaw`
    INSERT INTO "skill_card_grants" ("userId", "cardSha256", "reason", "sourceRef", "uploadedAt")
    VALUES (${userId}, ${cardSha256}, ${reason}, ${sourceRef}, CASE WHEN ${reason} = 'upload' THEN NOW() ELSE NULL END)
    ON CONFLICT ("userId", "cardSha256") DO UPDATE
    SET "uploadedAt" = COALESCE("skill_card_grants"."uploadedAt", EXCLUDED."uploadedAt"),
        "priorSourceRef" = CASE WHEN EXCLUDED."reason" = 'catalog' AND "skill_card_grants"."reason" NOT IN ('upload', 'catalog')
          THEN "skill_card_grants"."sourceRef" ELSE "skill_card_grants"."priorSourceRef" END,
        "reason" = CASE WHEN EXCLUDED."reason" = 'catalog' THEN 'catalog' ELSE "skill_card_grants"."reason" END,
        "sourceRef" = CASE WHEN EXCLUDED."reason" = 'catalog' THEN EXCLUDED."sourceRef" ELSE "skill_card_grants"."sourceRef" END
    WHERE EXCLUDED."reason" IN ('upload', 'catalog')
  `
}

export function cardMetadata(card: {
  sha256: string
  size: number
  contentHash: string
  executablePaths: Prisma.JsonValue
}): CardMetadata {
  return {
    sha256: card.sha256,
    size: card.size,
    contentHash: card.contentHash,
    executablePaths: Array.isArray(card.executablePaths)
      ? card.executablePaths.filter((path): path is string => typeof path === 'string')
      : [],
  }
}

/**
 * Gives a legacy version (bytes only in `packageData`) its content card,
 * attributed to and granted for the Skill author. Returns null when the
 * version has no package or its stored bytes fail validation.
 */
export async function ensureVersionCard(versionId: string): Promise<string | null> {
  const version = await db.skillVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      cardSha256: true,
      packageData: true,
      packageSha256: true,
      skill: { select: { authorId: true } },
    },
  })
  if (!version) return null
  if (version.cardSha256) return version.cardSha256
  if (!version.packageData) return null
  const data = Buffer.from(version.packageData)
  const actualSha256 = createHash('sha256').update(data).digest('hex')
  if (version.packageSha256 && version.packageSha256 !== actualSha256) {
    throw new CardIntegrityError('Stored checksum does not match package bytes')
  }
  let card: PreparedCard
  try {
    card = await prepareCard(data)
  } catch (error: unknown) {
    // Only invalid legacy bytes mean "no card"; storage failures must surface.
    if (error instanceof SkillPackageValidationError) return null
    throw error
  }
  return db.$transaction(async (transaction) => {
    await registerCard(transaction, card, version.skill.authorId)
    await transaction.skillVersion.updateMany({
      where: { id: version.id, cardSha256: null },
      data: { cardSha256: card.sha256 },
    })
    await grantCard(transaction, version.skill.authorId, card.sha256, 'authored', `version:${version.id}`)
    const current = await transaction.skillVersion.findUnique({
      where: { id: version.id },
      select: { cardSha256: true },
    })
    return current?.cardSha256 ?? null
  })
}

/**
 * Package bytes for a stored version during the transition: the card file
 * first, then the legacy `packageData` column. A missing or damaged card file
 * falls back to the database copy and is reported through `onCardFailure`.
 */
export async function loadVersionPackage(
  version: { cardSha256?: string | null; packageData: Uint8Array | null },
  onCardFailure?: (error: unknown) => void
): Promise<Buffer | null> {
  if (version.cardSha256) {
    try {
      const card = await db.skillCard.findUnique({
        where: { sha256: version.cardSha256 },
        select: { storageKey: true, storageProvider: true, storageNamespace: true },
      })
      if (card) return await readCardBytes(card.storageKey, version.cardSha256, card)
      onCardFailure?.(new CardIntegrityError('Card row is missing'))
    } catch (error: unknown) {
      if (!(error instanceof ObjectMissingError) && !(error instanceof CardIntegrityError)) throw error
      onCardFailure?.(error)
    }
  }
  return version.packageData ? Buffer.from(version.packageData) : null
}
