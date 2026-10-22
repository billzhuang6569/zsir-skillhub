import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { db } from '../db.js'
import { CardIntegrityError, verifyStoredCard } from '../lib/card-store.js'
import { ensureVersionCard } from '../lib/skill-cards.js'

export type CardOperation = { mode: 'report' | 'backfill' | 'verify'; apply: boolean; limit: number }

export function parseCardOperation(args: string[]): CardOperation {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    apply: { type: 'boolean', default: false },
    limit: { type: 'string', default: '1000' },
  } })
  const mode = z.enum(['report', 'backfill', 'verify']).parse(positionals[0] ?? 'report')
  if (positionals.length > 1 || !/^[1-9]\d{0,4}$/.test(values.limit)) throw new Error('Invalid operation or limit')
  if (values.apply && mode !== 'backfill') throw new Error('Only backfill can apply changes')
  return { mode, apply: values.apply, limit: Number(values.limit) }
}

/** Order-independent digest of every stored version checksum, comparable before and after a release. */
async function versionPackageDigest(): Promise<string> {
  const versions = await db.skillVersion.findMany({
    where: { packageSha256: { not: null } },
    select: { id: true, packageSha256: true },
    orderBy: { id: 'asc' },
  })
  const hash = createHash('sha256')
  for (const version of versions) hash.update(`${version.id}:${version.packageSha256}\n`, 'utf8')
  return hash.digest('hex')
}

export async function cardCoverage(): Promise<Record<string, number | string>> {
  const [versionsWithPackage, versionsWithCard, legacyOnly, cards, cardBytes, grants, entries] = await Promise.all([
    db.skillVersion.count({ where: { OR: [{ packageData: { not: null } }, { cardSha256: { not: null } }] } }),
    db.skillVersion.count({ where: { cardSha256: { not: null } } }),
    db.skillVersion.count({ where: { packageData: { not: null }, cardSha256: null } }),
    db.skillCard.count(),
    db.skillCard.aggregate({ _sum: { size: true } }),
    db.cardGrant.count(),
    db.libraryEntry.count(),
  ])
  return {
    versionsWithPackage,
    versionsWithCard,
    legacyOnly,
    cards,
    cardBytes: cardBytes._sum.size ?? 0,
    grants,
    libraryEntries: entries,
    versionPackageDigest: await versionPackageDigest(),
  }
}

/** Gives legacy versions their cards; safe to re-run because already-carded versions are skipped. */
export async function backfillCards(operation: CardOperation): Promise<Record<string, number | string[]>> {
  // Walk by id so versions that cannot be carded never block newer ones.
  const pending: string[] = []
  let cursor: string | undefined
  while (pending.length < operation.limit) {
    const batch = await db.skillVersion.findMany({
      where: { packageData: { not: null }, cardSha256: null, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: Math.min(200, operation.limit - pending.length),
    })
    if (batch.length === 0) break
    pending.push(...batch.map((version) => version.id))
    cursor = batch.at(-1)?.id
  }
  if (!operation.apply) return { pending: pending.length, carded: 0, skipped: [], mismatched: [] }
  let carded = 0
  const skipped: string[] = []
  const mismatched: string[] = []
  for (const versionId of pending) {
    // One version at a time keeps peak memory at a single 20 MB package.
    try {
      const cardSha256 = await ensureVersionCard(versionId)
      if (cardSha256) carded += 1
      else skipped.push(versionId)
    } catch (error: unknown) {
      // A stored checksum that disagrees with its bytes is an existing data
      // problem (legacy downloads already refuse it); report, never abort.
      if (!(error instanceof CardIntegrityError)) throw error
      mismatched.push(versionId)
    }
  }
  return { pending: pending.length, carded, skipped, mismatched }
}

/**
 * Restore check: every card row must have an intact file, and every version
 * or library entry must reference an existing card row.
 */
export async function verifyCards(): Promise<Record<string, number | string[]>> {
  const cards = await db.skillCard.findMany({ select: { sha256: true, storageKey: true, storageProvider: true, storageNamespace: true } })
  const damaged: string[] = []
  for (const card of cards) {
    if (!await verifyStoredCard(card.storageKey, card.sha256, card)) damaged.push(card.sha256)
  }
  const knownCards = new Set(cards.map((card) => card.sha256))
  const [versions, entries] = await Promise.all([
    db.skillVersion.findMany({ where: { cardSha256: { not: null } }, select: { cardSha256: true } }),
    db.libraryEntry.findMany({ select: { cardSha256: true } }),
  ])
  const dangling = [...versions, ...entries]
    .map((row) => row.cardSha256)
    .filter((sha256): sha256 is string => sha256 !== null && !knownCards.has(sha256))
  return { cards: cards.length, damaged, dangling: [...new Set(dangling)] }
}

export async function runCardOperation(operation: CardOperation): Promise<Record<string, unknown>> {
  if (operation.mode === 'report') return cardCoverage()
  if (operation.mode === 'verify') return verifyCards()
  return backfillCards(operation)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runCardOperation(parseCardOperation(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result)}\n`)
    // Skipped legacy versions keep serving their database copy and are only
    // reported; damaged or dangling cards would break restores and fail.
    const failed = (Array.isArray(result.damaged) && result.damaged.length > 0)
      || (Array.isArray(result.dangling) && result.dangling.length > 0)
    if (failed) process.exitCode = 1
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Skill card operation failed'}\n`)
    process.exitCode = 1
  } finally {
    await db.$disconnect()
  }
}
