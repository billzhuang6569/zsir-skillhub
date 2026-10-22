import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { PrismaClient } from '@prisma/client'
import {
  decodeCredentialKekKeyring,
  decryptLegacyBindingValue,
  destroyCredentialKekKeyring,
  encryptCredentialValue,
  type CredentialKekKeyring,
} from '../lib/credential-crypto.js'

// One-time data move for migration 20261013200000_team_credentials (#254).
//
// Release order (deploy/activate-production-release.sh):
//   database backup → `node dist/ops/team-credentials-migration.js stage
//   --report <file>` → `prisma migrate deploy` → service switch.
//
// `stage` reads every active, published per-Skill binding, decrypts it with
// the KEK keyring, groups by (teamId, envKey) and re-encrypts the winning
// value under the team AAD {credentialId, teamId, envKey, revision: 1}:
//   - every value in the group equal → one team key (merged);
//   - values differ → the newest version wins, the others are listed in the
//     report (ids and key names only) and dropped with the old tables.
// The holder is the winning binding's creator; the credential id reuses the
// winning binding id so earlier usage audit rows keep pointing at it.
// The SQL migration refuses to run unless the stage covers every active
// binding at its current revision. Re-running `stage` replaces the stage.
// When the legacy tables are already gone, `stage` is a no-op.

export const STAGE_TABLE = 'team_credential_migration_stage'

type RawClient = Pick<PrismaClient, '$queryRaw' | '$queryRawUnsafe' | '$executeRaw' | '$executeRawUnsafe' | '$transaction'>

type LegacyRow = {
  bindingId: string
  skillId: string
  teamId: string
  envKey: string
  currentRevision: number
  bindingCreatedById: string
  bindingCreatedAt: Date
  teamDissolvedAt: Date | null
  versionId: string | null
  versionCreatedById: string | null
  versionCreatedAt: Date | null
  ciphertext: Buffer | null
  iv: Buffer | null
  tag: Buffer | null
  wrappedDek: Buffer | null
  wrapIv: Buffer | null
  wrapTag: Buffer | null
  kekVersion: number | null
  aadVersion: number | null
}

export type MigrationReportGroup = {
  teamId: string
  envKey: string
  credentialId: string
  holderId: string
  status: 'active' | 'revoked'
  winner: { bindingId: string; skillId: string }
  merged: Array<{ bindingId: string; skillId: string }>
  discarded: Array<{ bindingId: string; skillId: string }>
}

/** Ids and key names only: never values, ciphertext or key material. */
export type MigrationReport = {
  migration: '20261013200000_team_credentials'
  generatedAt: string
  legacyTablesPresent: boolean
  activeBindings: number
  inactiveBindings: number
  stagedCredentials: number
  conflicts: number
  groups: MigrationReportGroup[]
}

export type StageInput = {
  keyring: CredentialKekKeyring
  currentKek: Buffer
  currentKekVersion: number
  now?: Date
}

const STAGE_DDL = `CREATE TABLE "${STAGE_TABLE}" (
    "credentialId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "envKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "versionId" TEXT NOT NULL,
    "versionCreatedById" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "wrapIv" BYTEA NOT NULL,
    "wrapTag" BYTEA NOT NULL,
    "kekVersion" INTEGER NOT NULL,
    "aadVersion" INTEGER NOT NULL,
    "sourceBindingIds" TEXT[] NOT NULL,
    "sourceRevisions" INTEGER[] NOT NULL,
    CONSTRAINT "${STAGE_TABLE}_pkey" PRIMARY KEY ("credentialId")
)`

function sameValue(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  try {
    return a.length === b.length && timingSafeEqual(a, b)
  } finally {
    a.fill(0)
    b.fill(0)
  }
}

/** Newest version first; ties by revision, then binding id for determinism. */
function newestFirst(left: LegacyRow, right: LegacyRow): number {
  const byTime = (right.versionCreatedAt?.getTime() ?? 0) - (left.versionCreatedAt?.getTime() ?? 0)
  if (byTime !== 0) return byTime
  if (right.currentRevision !== left.currentRevision) return right.currentRevision - left.currentRevision
  return left.bindingId < right.bindingId ? -1 : left.bindingId > right.bindingId ? 1 : 0
}

async function legacyTablesPresent(client: RawClient): Promise<boolean> {
  const rows = await client.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass('public.credential_bindings') IS NOT NULL AS "present"
  `
  return rows[0]?.present === true
}

export async function stageTeamCredentialMigration(client: RawClient, input: StageInput): Promise<MigrationReport> {
  const now = input.now ?? new Date()
  const report: MigrationReport = {
    migration: '20261013200000_team_credentials',
    generatedAt: now.toISOString(),
    legacyTablesPresent: false,
    activeBindings: 0,
    inactiveBindings: 0,
    stagedCredentials: 0,
    conflicts: 0,
    groups: [],
  }
  if (!await legacyTablesPresent(client)) return report
  report.legacyTablesPresent = true

  await client.$transaction(async (transaction) => {
    // Hold the legacy bindings still while reading, so the stage is a
    // consistent snapshot; the SQL guard rejects anything written later.
    await transaction.$executeRawUnsafe('LOCK TABLE "credential_bindings", "credential_versions" IN SHARE MODE')
    const counts = await transaction.$queryRaw<Array<{ active: number; inactive: number }>>`
      SELECT
        COUNT(*) FILTER (WHERE "status" = 'active' AND "currentRevision" > 0)::int AS "active",
        COUNT(*) FILTER (WHERE NOT ("status" = 'active' AND "currentRevision" > 0))::int AS "inactive"
      FROM "credential_bindings"
    `
    report.activeBindings = Number(counts[0]?.active ?? 0)
    report.inactiveBindings = Number(counts[0]?.inactive ?? 0)
    const rows = await transaction.$queryRaw<LegacyRow[]>`
      SELECT
        binding."id" AS "bindingId", binding."skillId", binding."teamId", binding."envKey",
        binding."currentRevision", binding."createdById" AS "bindingCreatedById",
        binding."createdAt" AS "bindingCreatedAt", team."dissolvedAt" AS "teamDissolvedAt",
        version."id" AS "versionId", version."createdById" AS "versionCreatedById",
        version."createdAt" AS "versionCreatedAt",
        version."ciphertext", version."iv", version."tag", version."wrappedDek",
        version."wrapIv", version."wrapTag", version."kekVersion", version."aadVersion"
      FROM "credential_bindings" AS binding
      JOIN "teams" AS team ON team."id" = binding."teamId"
      LEFT JOIN "credential_versions" AS version
        ON version."bindingId" = binding."id" AND version."revision" = binding."currentRevision"
      WHERE binding."status" = 'active' AND binding."currentRevision" > 0
      ORDER BY binding."teamId", binding."envKey", binding."id"
    `

    const groups = new Map<string, LegacyRow[]>()
    for (const row of rows) {
      const groupKey = `${row.teamId}\0${row.envKey}`
      groups.set(groupKey, [...(groups.get(groupKey) ?? []), row])
    }

    await transaction.$executeRawUnsafe(`DROP TABLE IF EXISTS "${STAGE_TABLE}"`)
    await transaction.$executeRawUnsafe(STAGE_DDL)

    for (const members of groups.values()) {
      const values = new Map<string, string>()
      for (const row of members) {
        if (
          !row.versionId || !row.versionCreatedById || !row.ciphertext || !row.iv || !row.tag
          || !row.wrappedDek || !row.wrapIv || !row.wrapTag || row.kekVersion === null || row.aadVersion === null
        ) {
          throw new Error(`Binding ${row.bindingId} has no stored version for revision ${row.currentRevision}`)
        }
        values.set(row.bindingId, decryptLegacyBindingValue(
          {
            ciphertext: row.ciphertext,
            iv: row.iv,
            tag: row.tag,
            wrappedDek: row.wrappedDek,
            wrapIv: row.wrapIv,
            wrapTag: row.wrapTag,
            kekVersion: row.kekVersion,
            aadVersion: row.aadVersion,
          },
          {
            bindingId: row.bindingId,
            skillId: row.skillId,
            teamId: row.teamId,
            envKey: row.envKey,
            revision: row.currentRevision,
          },
          input.keyring
        ))
      }
      const ordered = [...members].sort(newestFirst)
      const winner = ordered[0]
      if (!winner) continue
      const winningValue = values.get(winner.bindingId) ?? ''
      const merged = ordered.slice(1).filter((row) => sameValue(values.get(row.bindingId) ?? '', winningValue))
      const discarded = ordered.slice(1).filter((row) => !sameValue(values.get(row.bindingId) ?? '', winningValue))
      const credentialId = winner.bindingId
      const status: 'active' | 'revoked' = winner.teamDissolvedAt ? 'revoked' : 'active'
      const encrypted = encryptCredentialValue(
        winningValue,
        { credentialId, teamId: winner.teamId, envKey: winner.envKey, revision: 1 },
        input.currentKek,
        input.currentKekVersion
      )
      values.clear()
      const sourceIds = members.map((row) => row.bindingId)
      const sourceRevisions = members.map((row) => row.currentRevision)
      await transaction.$executeRaw`
        INSERT INTO "team_credential_migration_stage" (
          "credentialId", "teamId", "envKey", "status", "createdById", "createdAt", "revokedAt",
          "versionId", "versionCreatedById", "ciphertext", "iv", "tag", "wrappedDek", "wrapIv", "wrapTag",
          "kekVersion", "aadVersion", "sourceBindingIds", "sourceRevisions"
        ) VALUES (
          ${credentialId}, ${winner.teamId}, ${winner.envKey}, ${status}, ${winner.bindingCreatedById},
          ${winner.bindingCreatedAt}, ${winner.teamDissolvedAt}, ${randomUUID()}, ${winner.versionCreatedById},
          ${encrypted.ciphertext}, ${encrypted.iv}, ${encrypted.tag}, ${encrypted.wrappedDek},
          ${encrypted.wrapIv}, ${encrypted.wrapTag}, ${encrypted.kekVersion}, ${encrypted.aadVersion},
          ${sourceIds}::text[], ${sourceRevisions}::int[]
        )
      `
      report.stagedCredentials += 1
      if (discarded.length > 0) report.conflicts += 1
      report.groups.push({
        teamId: winner.teamId,
        envKey: winner.envKey,
        credentialId,
        holderId: winner.bindingCreatedById,
        status,
        winner: { bindingId: winner.bindingId, skillId: winner.skillId },
        merged: merged.map((row) => ({ bindingId: row.bindingId, skillId: row.skillId })),
        discarded: discarded.map((row) => ({ bindingId: row.bindingId, skillId: row.skillId })),
      })
    }
  }, { timeout: 120_000 })
  return report
}

function parseKeyringJson(value: string | undefined): Record<string, string> {
  if (!value || !value.trim()) return {}
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('CREDENTIAL_KEK_KEYRING_JSON must be a JSON object')
  }
  const result: Record<string, string> = {}
  for (const [version, key] of Object.entries(parsed)) {
    if (typeof key !== 'string') throw new Error('CREDENTIAL_KEK_KEYRING_JSON values must be strings')
    result[version] = key
  }
  return result
}

/** `--report -` writes the report JSON to stdout (the deploy captures it as root). */
export function parseStageArgs(args: string[]): { report: string } {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { report: { type: 'string' } } })
  if (positionals.length !== 1 || positionals[0] !== 'stage') throw new Error('Usage: team-credentials-migration.js stage --report <file|->')
  if (!values.report) throw new Error('--report <file|-> is required')
  return { report: values.report === '-' ? '-' : resolve(values.report) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const client = new PrismaClient()
  let keyring: Map<number, Buffer> | null = null
  try {
    const { report: reportPath } = parseStageArgs(process.argv.slice(2))
    const currentKekVersion = Number(process.env.CREDENTIAL_KEK_VERSION ?? '1')
    keyring = decodeCredentialKekKeyring(
      process.env.CREDENTIAL_KEK_BASE64,
      currentKekVersion,
      parseKeyringJson(process.env.CREDENTIAL_KEK_KEYRING_JSON)
    )
    const currentKek = keyring.get(currentKekVersion)
    if (!currentKek) throw new Error('Current credential KEK is unavailable')
    const report = await stageTeamCredentialMigration(client, { keyring, currentKek, currentKekVersion })
    if (reportPath === '-') {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    } else {
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
      chmodSync(reportPath, 0o600)
    }
    process.stderr.write(`${JSON.stringify({
      legacyTablesPresent: report.legacyTablesPresent,
      activeBindings: report.activeBindings,
      inactiveBindings: report.inactiveBindings,
      stagedCredentials: report.stagedCredentials,
      conflicts: report.conflicts,
      report: reportPath,
    })}\n`)
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Team credential staging failed'}\n`)
    process.exitCode = 1
  } finally {
    if (keyring) destroyCredentialKekKeyring(keyring)
    await client.$disconnect()
  }
}
