import { createHash, randomUUID } from 'node:crypto'
import type { LibraryEntry, Prisma } from '@prisma/client'
import { z } from 'zod'
import { lockSkillMutation, lockTeamMutation } from './mutation-lock.js'

export class VersionPolicyError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message) }
}

export function versionOrdinal(label: string): number | null {
  return /^[0-9]\.[0-9]\.[0-9]$/.test(label) ? Number(label.replaceAll('.', '')) : null
}

export function requireVersion(label: string): number {
  const ordinal = versionOrdinal(label)
  if (ordinal === null) throw new VersionPolicyError('VERSION_FORMAT_INVALID', 'Use a version such as 0.1.0; upgrade SkillHub to continue.', 400)
  return ordinal
}

export function allocateVersion(highWater: number, requested = '0.1.0', mode: 'auto' | 'manual' = 'auto'): string {
  const value = requireVersion(requested)
  if (highWater >= 999) throw new VersionPolicyError('VERSION_RANGE_EXHAUSTED', 'Skill version range is exhausted')
  if (mode === 'manual' && value <= highWater) throw new VersionPolicyError('VERSION_LABEL_CONFLICT', 'Version must be above the complete version history')
  const next = mode === 'manual' ? value : Math.max(value, highWater + 1)
  return `${Math.floor(next / 100)}.${Math.floor(next / 10) % 10}.${next % 10}`
}

export function mappingDigest(rows: readonly { versionId: string; oldLabel: string; newLabel: string; planDigest: string }[]): string | null {
  if (rows.length === 0) return null
  const values = rows.map(({ versionId, oldLabel, newLabel, planDigest }) => [versionId, oldLabel, newLabel, planDigest])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'))
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

export const VersionIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('save'), requestId: z.string().uuid(), cardSha256: z.string().regex(/^[a-f0-9]{64}$/), allocation: z.enum(['auto', 'manual']), label: z.string().min(1).max(40) }).strict(),
  z.object({ kind: z.literal('select'), receiptId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('formal'), versionId: z.string().uuid() }).strict(),
])
export type VersionIntent = z.infer<typeof VersionIntentSchema>

export async function sameCardContent(tx: Prisma.TransactionClient, left: string, right: string): Promise<boolean> {
  if (left === right) return true
  const cards = await tx.skillCard.findMany({ where: { sha256: { in: [left, right] } } })
  return cards.length === 2 && cards[0]!.contentHash === cards[1]!.contentHash
    && JSON.stringify(cards[0]!.executablePaths) === JSON.stringify(cards[1]!.executablePaths)
}
export const receiptInclude = { formalVersion: { select: { version: true, aliases: true } } } as const
export type Receipt = Prisma.LibraryEntryVersionGetPayload<{ include: typeof receiptInclude }>

export function receiptDto(receipt: Receipt): {
  receiptId: string; label: string; cardSha256: string; formalVersionId: string | null; formalLabel: string | null
} {
  return { receiptId: receipt.id, label: receipt.label, cardSha256: receipt.cardSha256,
    formalVersionId: receipt.formalVersionId, formalLabel: receipt.formalVersion?.version ?? null }
}

export function formalVersionDto(version: { id: string; skillId: string; version: string; sourceUrl?: string | null; changelog: string | null; gitHash: string | null; packageSha256: string | null; packageSize: number | null; createdAt: Date; aliases: { oldLabel: string; versionId: string; newLabel: string; planDigest: string }[] }): Record<string, unknown> {
  return { id: version.id, skillId: version.skillId, version: version.version, changelog: version.changelog,
    sourceUrl: version.sourceUrl ?? null, gitHash: version.gitHash, packageSha256: version.packageSha256, packageSize: version.packageSize, createdAt: version.createdAt,
    aliases: (version.aliases ?? []).map((row) => row.oldLabel).sort(), versionMappingDigest: mappingDigest(version.aliases ?? []) }
}

const highWaterSelect = {
    id: true,
    currentVersion: true, versionHighWater: true,
    versions: { select: { version: true, aliases: { select: { oldLabel: true } } } },
    libraryEntries: { select: { versionHighWater: true, receipts: { select: { label: true } } } },
} as const satisfies Prisma.SkillSelect

function completeSkillHighWater(skill: Prisma.SkillGetPayload<{ select: typeof highWaterSelect }>): number {
  return Math.max(skill.versionHighWater,
    ...skill.versions.flatMap((v) => [versionOrdinal(v.version) ?? -1, ...v.aliases.map((a) => versionOrdinal(a.oldLabel) ?? -1)]),
    ...skill.libraryEntries.flatMap((e) => [e.versionHighWater, ...e.receipts.map((r) => versionOrdinal(r.label) ?? -1)]))
}

export async function skillHighWater(tx: Prisma.TransactionClient, skillId: string): Promise<number> {
  return completeSkillHighWater(await tx.skill.findUniqueOrThrow({ where: { id: skillId }, select: highWaterSelect }))
}

export async function entryHighWater(tx: Prisma.TransactionClient, entry: LibraryEntry): Promise<number> {
  if (entry.authorSkillId) return Math.max(entry.versionHighWater, await skillHighWater(tx, entry.authorSkillId))
  const receipts = await tx.libraryEntryVersion.findMany({ where: { entryId: entry.id }, select: { label: true } })
  return Math.max(entry.versionHighWater, ...receipts.map((r) => versionOrdinal(r.label) ?? -1))
}

export type EntryVersionMetadata = {
  versionPolicy: 1; versionHighWater: number; versionMappingDigest: string | null; version: ReturnType<typeof receiptDto> | null
}

export async function entryVersionMetadataBatch(tx: Prisma.TransactionClient, entries: LibraryEntry[]): Promise<Map<string, EntryVersionMetadata>> {
  if (!entries.length) return new Map()
  const authorIds = [...new Set(entries.flatMap((entry) => entry.authorSkillId ? [entry.authorSkillId] : []))]
  const [receipts, skills] = await Promise.all([
    tx.libraryEntryVersion.findMany({ where: { entryId: { in: entries.map((entry) => entry.id) } }, include: receiptInclude }),
    authorIds.length ? tx.skill.findMany({ where: { id: { in: authorIds } }, select: highWaterSelect }) : Promise.resolve([]),
  ])
  const highs = new Map(skills.map((skill) => [skill.id, completeSkillHighWater(skill)]))
  const groups = new Map<string, Receipt[]>()
  for (const receipt of receipts) { const group = groups.get(receipt.entryId) ?? []; group.push(receipt); groups.set(receipt.entryId, group) }
  return new Map(entries.map((entry) => {
    const own = groups.get(entry.id) ?? []
    const current = own.find((row) => row.id === entry.currentVersionReceiptId)
    if (own.length > 1000 || (entry.currentVersionReceiptId && (!current || current.cardSha256 !== entry.cardSha256))) throw new VersionPolicyError('VERSION_INTEGRITY_ERROR', 'Version receipt integrity check failed', 500)
    return [entry.id, { versionPolicy: 1 as const,
      versionHighWater: Math.max(entry.versionHighWater, highs.get(entry.authorSkillId ?? '') ?? -1, ...own.map((receipt) => versionOrdinal(receipt.label) ?? -1)),
      versionMappingDigest: mappingDigest(own.flatMap((receipt) => receipt.formalVersion?.aliases ?? [])), version: current ? receiptDto(current) : null }]
  }))
}

export async function entryVersionMetadata(tx: Prisma.TransactionClient, entry: LibraryEntry): Promise<EntryVersionMetadata> {
  return (await entryVersionMetadataBatch(tx, [entry])).get(entry.id)!
}

export async function lockEntryVersionSkills(tx: Prisma.TransactionClient, entry: Pick<LibraryEntry, 'authorSkillId'>, intent?: VersionIntent, sourceSkillId?: string, sourceTeamId?: string): Promise<void> {
  const formal = intent?.kind === 'formal' ? await tx.skillVersion.findUnique({ where: { id: intent.versionId }, select: { skillId: true } }) : null
  const ids = [...new Set([entry.authorSkillId, sourceSkillId, formal?.skillId].filter((id): id is string => Boolean(id)))].sort()
  for (const id of ids) await lockSkillMutation(tx, id)
  const shares = formal ? await tx.skillTeamShare.findMany({ where: { skillId: formal.skillId }, select: { teamId: true } }) : []
  const teams = [...new Set([...shares.map((share) => share.teamId), ...(sourceTeamId ? [sourceTeamId] : [])])].sort()
  for (const id of teams) await lockTeamMutation(tx, id)
}

function saveDigest(entryId: string, intent: Extract<VersionIntent, { kind: 'save' }>): string {
  return createHash('sha256').update(JSON.stringify({ schema: 1, entryId, cardSha256: intent.cardSha256, allocation: intent.allocation, label: intent.label })).digest('hex')
}

export async function replayReceipt(tx: Prisma.TransactionClient, entry: LibraryEntry, intent?: VersionIntent): Promise<Receipt | null> {
  if (intent?.kind !== 'save') return null
  const existing = await tx.libraryEntryVersion.findUnique({ where: { id: intent.requestId }, include: receiptInclude })
  if (!existing) return null
  if (existing.entryId !== entry.id || existing.requestDigest !== saveDigest(entry.id, intent)) {
    throw new VersionPolicyError('VERSION_REQUEST_CONFLICT', 'Version request id is already used by a different request')
  }
  return existing
}

export async function acceptVersionIntent(tx: Prisma.TransactionClient, entry: LibraryEntry, targetCard: string, intent?: VersionIntent): Promise<Receipt | null> {
  if (!intent) return entry.currentVersionReceiptId && targetCard === entry.cardSha256
    ? tx.libraryEntryVersion.findUnique({ where: { id: entry.currentVersionReceiptId }, include: receiptInclude }) : null
  if (await tx.libraryEntryVersion.count({ where: { entryId: entry.id } }) > 1000) throw new VersionPolicyError('VERSION_INTEGRITY_ERROR', 'Version receipt integrity check failed', 500)
  let label: string
  let formalVersionId: string | null = null
  if (intent.kind === 'select') {
    const receipt = await tx.libraryEntryVersion.findFirst({ where: { id: intent.receiptId, entryId: entry.id }, include: receiptInclude })
    if (!receipt || receipt.cardSha256 !== targetCard) throw new VersionPolicyError('VERSION_LABEL_CONFLICT', 'Selected version does not match the entry content')
    return receipt
  }
  const highWater = await entryHighWater(tx, entry)
  if (intent.kind === 'save') {
    if (intent.cardSha256 !== targetCard) throw new VersionPolicyError('VERSION_REQUEST_CONFLICT', 'Version content does not match the entry')
    const current = entry.currentVersionReceiptId ? await tx.libraryEntryVersion.findUnique({ where: { id: entry.currentVersionReceiptId }, include: receiptInclude }) : null
    if (current?.cardSha256 === targetCard) return current
    requireVersion(intent.label)
    label = allocateVersion(highWater, intent.label, intent.allocation)
  } else {
    const existing = await tx.libraryEntryVersion.findUnique({ where: { entryId_formalVersionId: { entryId: entry.id, formalVersionId: intent.versionId } }, include: receiptInclude })
    if (existing) {
      if (existing.cardSha256 !== targetCard) throw new VersionPolicyError('VERSION_REQUEST_CONFLICT', 'Formal version content changed')
      return existing
    }
    const formal = await tx.skillVersion.findUnique({ where: { id: intent.versionId }, include: {
      skill: { include: { teamShares: { include: { team: { include: { members: { where: { userId: entry.userId } } } } } } } },
      marketplaceListings: { where: { withdrawnAt: null, submission: { status: 'approved' } } },
      marketplaceSubmissions: { select: { id: true } },
    } })
    const grant = await tx.cardGrant.findUnique({ where: { userId_cardSha256: { userId: entry.userId, cardSha256: targetCard } } })
    const acquiredRefs = [grant?.sourceRef, grant?.priorSourceRef]
    const historicalReceipt = acquiredRefs.some((ref) => ref?.startsWith('team:')) ? await tx.libraryEntryVersion.findFirst({
      where: { formalVersionId: intent.versionId, cardSha256: targetCard, entry: { userId: entry.userId } }, select: { id: true },
    }) : null
    const previouslyAcquired = historicalReceipt !== null || acquiredRefs.includes(`version:${intent.versionId}`)
      || (formal?.marketplaceSubmissions.some((s) => acquiredRefs.includes(`submission:${s.id}`)) ?? false)
    const accessible = formal && (formal.skill.authorId === entry.userId || previouslyAcquired || (!formal.skill.deletedAt && (
      formal.marketplaceListings.length > 0 || formal.skill.teamShares.some((s) => !s.team.dissolvedAt && s.team.members.length > 0
        && (s.versionId ? s.versionId === formal.id : s.skillId === formal.skillId && formal.version === formal.skill.currentVersion)))))
    if (!formal || !accessible || !grant || formal.cardSha256 !== targetCard) throw new VersionPolicyError('VERSION_SOURCE_UNAVAILABLE', 'Formal version is not available to this account', 403)
    if (versionOrdinal(formal.version) === null) throw new VersionPolicyError('VERSION_LABEL_MIGRATION_REQUIRED', 'The source version needs label migration; refresh later')
    formalVersionId = formal.id
    if (formal.skillId === entry.authorSkillId) {
      const occupied = await tx.libraryEntryVersion.findUnique({ where: { entryId_label: { entryId: entry.id, label: formal.version } }, include: receiptInclude })
      if (occupied) {
        if (occupied.formalVersionId || !await sameCardContent(tx, occupied.cardSha256, targetCard)) throw new VersionPolicyError('VERSION_LABEL_CONFLICT', 'Formal label conflicts with a reserved version')
        return tx.libraryEntryVersion.update({ where: { id: occupied.id }, data: { formalVersionId: formal.id, cardSha256: targetCard }, include: receiptInclude })
      }
      label = formal.version
    } else label = allocateVersion(highWater, formal.version)
  }
  const receipt = await tx.libraryEntryVersion.create({ data: {
    id: intent.kind === 'save' ? intent.requestId : randomUUID(), entryId: entry.id, label, cardSha256: targetCard,
    formalVersionId, requestDigest: intent.kind === 'save' ? saveDigest(entry.id, intent) : null,
  }, include: receiptInclude })
  const nextHighWater = Math.max(highWater, requireVersion(label))
  await tx.libraryEntry.update({ where: { id: entry.id }, data: { versionHighWater: nextHighWater } })
  if (entry.authorSkillId) await tx.skill.update({ where: { id: entry.authorSkillId }, data: { versionHighWater: nextHighWater } })
  return receipt
}

export async function formalCandidates(tx: Prisma.TransactionClient, skillId: string, label: string): Promise<Prisma.SkillVersionGetPayload<{ include: { aliases: true } }>[]> {
  return tx.skillVersion.findMany({ where: { skillId, OR: [{ version: label }, { aliases: { some: { oldLabel: label } } }] }, include: { aliases: true } })
}

export async function exactFormalRetry(tx: Prisma.TransactionClient, skillId: string, label: string, digest: string): Promise<Awaited<ReturnType<typeof formalCandidates>>[number] | null> {
  const candidates = await formalCandidates(tx, skillId, label)
  if (candidates.length === 0) return null
  const matches = candidates.filter((v) => v.mutationDigest === digest)
  if (matches.length !== 1) throw new VersionPolicyError('VERSION_REQUEST_CONFLICT', 'Version request does not uniquely match an existing version')
  return matches[0]!
}
