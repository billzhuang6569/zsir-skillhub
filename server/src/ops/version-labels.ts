import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { Prisma, type PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { db } from '../db.js'
import { configSchema } from '../config-schema.js'
import { lockSkillMutation, lockUserMutation } from '../lib/mutation-lock.js'
import { versionOrdinal } from '../lib/version-policy.js'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ReceiptState = z.object({ id: z.string(), label: z.string(), cardSha256: z.string(), formalVersionId: z.string().nullable(), immutable: z.string() }).strict()
const VersionState = z.object({ id: z.string(), label: z.string(), cardSha256: z.string().nullable(), createdAt: z.string(), immutable: z.string() }).strict()
const SkillState = z.object({ id: z.string(), authorId: z.string(), importVersionId: z.string().nullable(), currentVersion: z.string(), versionHighWater: z.number().int(), immutable: z.string(), versions: z.array(VersionState) }).strict()
const EntryState = z.object({ id: z.string(), userId: z.string(), authorSkillId: z.string().nullable(), revision: z.number().int(), versionHighWater: z.number().int(), immutable: z.string(), receipts: z.array(ReceiptState) }).strict()
const AliasState = z.object({ skillId: z.string(), versionId: z.string(), oldLabel: z.string(), newLabel: z.string(), planDigest: z.string() }).strict()
const Inventory = z.object({ skills: z.array(SkillState), entries: z.array(EntryState), aliases: z.array(AliasState) }).strict()
type Inventory = z.infer<typeof Inventory>
const Change = z.object({ skillId: z.string(), versionId: z.string(), oldLabel: z.string(), newLabel: z.string() }).strict()
const PlanSchema = z.object({ schema: z.literal(2), before: Inventory, changes: z.array(Change), blockers: z.array(z.string()), versionLimit: z.number().int().min(1).max(1000), unverifiableImportCount: z.number().int().nonnegative(), planDigest: z.string() }).strict()
export type VersionLabelPlan = z.infer<typeof PlanSchema>

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const compareAliases = (a: z.infer<typeof AliasState>, b: z.infer<typeof AliasState>): number => compare(a.skillId, b.skillId) || compare(a.oldLabel, b.oldLabel)
// Explicit metadata projection: packageData/sourceContent and mutable presentation fields
// must never enter Node or invalidate an otherwise applicable reviewed plan.
export const migrationVersionSelect = { id: true, skillId: true, version: true, cardSha256: true, packageSha256: true, mutationDigest: true, createdAt: true } as const satisfies Prisma.SkillVersionSelect

/** Contains hashes, never package bytes, raw request digests or account credentials. */
async function inventory(tx: Prisma.TransactionClient, skillIds?: string[]): Promise<Inventory> {
  const skills = await tx.skill.findMany({ where: skillIds ? { id: { in: skillIds } } : undefined, select: {
    id: true, authorId: true, importVersionId: true, deletedAt: true, currentVersion: true, versionHighWater: true,
    versions: { select: migrationVersionSelect },
  } })
  const entries = await tx.libraryEntry.findMany({ where: skillIds ? { OR: [{ authorSkillId: { in: skillIds } }, { receipts: { some: { formalVersion: { skillId: { in: skillIds } } } } }] } : undefined, select: {
    id: true, userId: true, authorSkillId: true, cardSha256: true, currentVersionReceiptId: true, deletedAt: true, revision: true, versionHighWater: true,
    receipts: { select: { id: true, entryId: true, label: true, cardSha256: true, formalVersionId: true, requestDigest: true, createdAt: true } },
  } })
  const aliases = await tx.skillVersionLabelAlias.findMany({ where: skillIds ? { skillId: { in: skillIds } } : undefined })
  return {
    skills: skills.sort((a, b) => compare(a.id, b.id)).map(({ versions, currentVersion, versionHighWater, ...skill }) => ({
      id: skill.id, authorId: skill.authorId, importVersionId: skill.importVersionId, currentVersion, versionHighWater, immutable: digest(skill),
      versions: versions.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || compare(a.id, b.id)).map(({ version, ...row }) => ({ id: row.id, label: version, cardSha256: row.cardSha256, createdAt: row.createdAt.toISOString(), immutable: digest(row) })),
    })),
    entries: entries.sort((a, b) => compare(a.id, b.id)).map(({ receipts, revision, versionHighWater, ...entry }) => ({
      id: entry.id, userId: entry.userId, authorSkillId: entry.authorSkillId, revision, versionHighWater, immutable: digest(entry),
      receipts: receipts.sort((a, b) => compare(a.id, b.id)).map(({ label, ...row }) => ({ id: row.id, label, cardSha256: row.cardSha256, formalVersionId: row.formalVersionId, immutable: digest(row) })),
    })), aliases: aliases.sort(compareAliases),
  }
}

function planDigest(plan: Omit<VersionLabelPlan, 'planDigest'>): string { return digest(plan) }

export async function planVersionLabels(client: PrismaClient, versionLimit: number): Promise<VersionLabelPlan> {
  let before = await client.$transaction((tx) => inventory(tx), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 })
  const unverifiableImportCount = before.skills.filter((skill) => !skill.importVersionId).length
  const changes: VersionLabelPlan['changes'] = []
  const blockers: string[] = []
  for (const skill of before.skills) {
    if (skill.versions.length === 0) continue
    const ordered = (labels: string[]): boolean => labels.every((label, index) => versionOrdinal(label) !== null && (index === 0 || requireOrdinal(labels[index - 1]!) < requireOrdinal(label)))
    if (skill.versions.filter((v) => v.label === skill.currentVersion).length !== 1) blockers.push(`${skill.id}: current version is not unique`)
    if (skill.versions.length > versionLimit) blockers.push(`${skill.id}: ${skill.versions.length} formal versions exceeds quota ${versionLimit}; review required`)
    if (ordered(skill.versions.map((v) => v.label))) continue
    const stripped = skill.versions.map((v) => v.label.replace(/^v/, ''))
    const labels = ordered(stripped) ? stripped : skill.versions.map((_, index) => {
      const value = index + 10
      return `${Math.floor(value / 100)}.${Math.floor(value / 10) % 10}.${value % 10}`
    })
    if (labels.some((label) => versionOrdinal(label) === null)) {
      blockers.push(`${skill.id}: insufficient numeric labels`)
      continue
    }
    for (const [index, row] of skill.versions.entries()) {
      if (row.label === labels[index]) continue
      if (before.aliases.some((a) => a.skillId === skill.id && a.oldLabel === row.label)) blockers.push(`${skill.id}: historical alias already reserved for ${row.label}`)
      changes.push({ skillId: skill.id, versionId: row.id, oldLabel: row.label, newLabel: labels[index]! })
    }
  }
  const scope = new Set(changes.map((change) => change.skillId))
  const scopedVersions = new Set(before.skills.filter((skill) => scope.has(skill.id)).flatMap((skill) => skill.versions.map((version) => version.id)))
  before = { skills: before.skills.filter((skill) => scope.has(skill.id)),
    entries: before.entries.filter((entry) => (entry.authorSkillId && scope.has(entry.authorSkillId)) || entry.receipts.some((receipt) => receipt.formalVersionId && scopedVersions.has(receipt.formalVersionId))),
    aliases: before.aliases.filter((alias) => scope.has(alias.skillId)) }
  const unsigned = { schema: 2 as const, before, changes, blockers, versionLimit, unverifiableImportCount }
  const plan = { ...unsigned, planDigest: planDigest(unsigned) }
  const target = transformed(plan, false)
  for (const entry of target.entries) {
    if (new Set(entry.receipts.map((r) => r.label)).size !== entry.receipts.length) blockers.push(`${entry.id}: migration collides with a personal receipt`)
  }
  for (const skill of target.skills) {
    const reserved = target.entries.filter((entry) => entry.authorSkillId === skill.id).flatMap((entry) => entry.receipts)
    for (const receipt of reserved) {
      if (skill.versions.some((v) => v.label === receipt.label && (v.cardSha256 !== receipt.cardSha256
        || (receipt.formalVersionId !== null && receipt.formalVersionId !== v.id)))) {
        blockers.push(`${skill.id}: formal label collides with reserved content or version identity`)
      }
    }
  }
  return { ...unsigned, planDigest: planDigest(unsigned) }
}

function requireOrdinal(label: string): number {
  const result = versionOrdinal(label)
  if (result === null) throw new Error('Migration target contains an invalid version')
  return result
}

function transformed(plan: VersionLabelPlan, rollback: boolean): Inventory {
  const result = structuredClone(plan.before)
  const changes = new Map(plan.changes.map((change) => [change.versionId, change]))
  for (const skill of result.skills) {
    const ownChanges = plan.changes.filter((change) => change.skillId === skill.id)
    if (ownChanges.length === 0) continue
    const currentId = skill.versions.find((row) => row.label === skill.currentVersion)?.id
    for (const version of skill.versions) {
      const change = changes.get(version.id)
      if (change && !rollback) version.label = change.newLabel
    }
    if (currentId && !rollback) skill.currentVersion = changes.get(currentId)?.newLabel ?? skill.currentVersion
    skill.versionHighWater = Math.max(skill.versionHighWater,
      ...plan.before.skills.find((s) => s.id === skill.id)!.versions.map((v) => versionOrdinal(v.label) ?? -1),
      ...ownChanges.map((c) => requireOrdinal(c.newLabel)),
      ...plan.before.aliases.filter((a) => a.skillId === skill.id).map((a) => versionOrdinal(a.oldLabel) ?? -1),
      ...result.entries.filter((e) => e.authorSkillId === skill.id).flatMap((e) => [e.versionHighWater, ...e.receipts.map((r) => versionOrdinal(r.label) ?? -1)]))
  }
  for (const entry of result.entries) {
    let affected = false
    for (const receipt of entry.receipts) {
      const change = receipt.formalVersionId ? changes.get(receipt.formalVersionId) : undefined
      if (!change) continue
      affected = true
      if (change.skillId === entry.authorSkillId) {
        entry.versionHighWater = Math.max(entry.versionHighWater, requireOrdinal(change.newLabel), versionOrdinal(receipt.label) ?? -1)
        if (!rollback) receipt.label = change.newLabel
      }
    }
    if (affected) entry.revision += rollback ? 2 : 1
  }
  if (!rollback) result.aliases.push(...plan.changes.map((c) => ({ ...c, planDigest: plan.planDigest })))
  result.aliases.sort(compareAliases)
  return result
}

/** Serializable snapshot plus the production mutation locks; conflicts stop for a fresh plan. */
export async function applyVersionLabels(client: PrismaClient, input: unknown, confirmedDigest: string, rollback = false): Promise<'applied' | 'rolled_back' | 'unchanged'> {
  const plan = PlanSchema.parse(input)
  const { planDigest: supplied, ...unsigned } = plan
  if (supplied !== confirmedDigest || supplied !== planDigest(unsigned)) throw new Error('Reviewed plan digest mismatch')
  if (plan.blockers.length) throw new Error('Migration plan has unresolved blockers')
  if (!plan.changes.length) return 'unchanged'
  const after = transformed(plan, false)
  const rolledBack = transformed(plan, true)
  const expected = rollback ? after : plan.before
  const target = rollback ? rolledBack : after
  return client.$transaction(async (tx) => {
    const users = [...new Set([...plan.before.skills.map((s) => s.authorId), ...plan.before.entries.map((e) => e.userId)])].sort()
    for (const user of users) await lockUserMutation(tx, user)
    for (const skill of plan.before.skills) await lockSkillMutation(tx, skill.id)
    const scopeIds = plan.before.skills.map((skill) => skill.id)
    const current = await inventory(tx, scopeIds)
    if (digest(current) === digest(target)) return 'unchanged'
    if (digest(current) !== digest(expected)) throw new Error('Migration state changed; regenerate the reviewed plan')
    // Transaction-private placeholders avoid unique-label swaps without changing immutable rows.
    for (const change of plan.changes) await tx.skillVersion.update({ where: { id: change.versionId }, data: { version: `migration-${plan.planDigest}-${change.versionId}` } })
    for (const entry of target.entries) for (const receipt of entry.receipts) {
      const previous = current.entries.find((e) => e.id === entry.id)!.receipts.find((r) => r.id === receipt.id)!
      if (receipt.label !== previous.label) await tx.libraryEntryVersion.update({ where: { id: receipt.id }, data: { label: `migration-${receipt.id}` } })
    }
    for (const change of plan.changes) await tx.skillVersion.update({ where: { id: change.versionId }, data: { version: rollback ? change.oldLabel : change.newLabel } })
    for (const skill of target.skills) {
      const previous = current.skills.find((s) => s.id === skill.id)!
      if (skill.currentVersion !== previous.currentVersion || skill.versionHighWater !== previous.versionHighWater) await tx.skill.update({ where: { id: skill.id }, data: { currentVersion: skill.currentVersion, versionHighWater: skill.versionHighWater } })
    }
    for (const entry of target.entries) {
      for (const receipt of entry.receipts) {
        const previous = current.entries.find((e) => e.id === entry.id)!.receipts.find((r) => r.id === receipt.id)!
        if (receipt.label !== previous.label) await tx.libraryEntryVersion.update({ where: { id: receipt.id }, data: { label: receipt.label } })
      }
      const previous = current.entries.find((e) => e.id === entry.id)!
      if (entry.revision !== previous.revision || entry.versionHighWater !== previous.versionHighWater) await tx.libraryEntry.update({ where: { id: entry.id }, data: { revision: entry.revision, versionHighWater: entry.versionHighWater } })
    }
    if (rollback) await tx.skillVersionLabelAlias.deleteMany({ where: { planDigest: plan.planDigest } })
    else await tx.skillVersionLabelAlias.createMany({ data: plan.changes.map((c) => ({ ...c, planDigest: plan.planDigest })) })
    if (digest(await inventory(tx, scopeIds)) !== digest(target)) throw new Error('Migration readback failed')
    return rollback ? 'rolled_back' : 'applied'
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 })
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' }, plan: { type: 'string' }, digest: { type: 'string' }, apply: { type: 'boolean', default: false }, rollback: { type: 'boolean', default: false } } })
  try {
    if (!values.apply) {
      if (!values.out || values.rollback) throw new Error('Dry-run requires --out; rollback requires --apply --plan --digest')
      const limit = configSchema.innerType().shape.SKILL_MAX_VERSIONS_PER_SKILL.parse(process.env['SKILL_MAX_VERSIONS_PER_SKILL'])
      const plan = await planVersionLabels(db, limit)
      await writeFile(resolve(values.out), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      process.stdout.write(`${JSON.stringify({ planDigest: plan.planDigest, changes: plan.changes.length, blockers: plan.blockers.length, skills: plan.before.skills.length, entries: plan.before.entries.length, unverifiableImportCount: plan.unverifiableImportCount, renamedCanonicalLabels: plan.changes.filter((change) => versionOrdinal(change.oldLabel) !== null).length })}\n`)
    } else {
      if (!values.plan || !values.digest) throw new Error('Apply requires --plan and the reviewed --digest')
      const outcome = await applyVersionLabels(db, JSON.parse(await readFile(resolve(values.plan), 'utf8')) as unknown, values.digest, values.rollback)
      process.stdout.write(`${outcome}\n`)
    }
  } finally { await db.$disconnect() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Version migration failed; preserve the private plan and review state before retrying.\n'); process.exitCode = 1 })
}
