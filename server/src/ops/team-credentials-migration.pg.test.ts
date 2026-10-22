import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decryptCredentialValue, encryptLegacyBindingValue } from '../lib/credential-crypto.js'
import { stageTeamCredentialMigration, type MigrationReport } from './team-credentials-migration.js'

// Runs the real migration 20261013200000_team_credentials with `prisma
// migrate deploy` against throwaway databases cloned from a template that
// stops one migration earlier, with legacy fixtures encrypted under the
// retired binding AAD.

const postgresUrl = process.env['SKILLHUB_PG_TEST_URL']
const describePostgres = postgresUrl ? describe : describe.skip
const TARGET = '20261013200000_team_credentials'
const serverRoot = fileURLToPath(new URL('../../', import.meta.url))
const prismaBin = join(serverRoot, 'node_modules/.bin/prisma')
const KEK = Buffer.alloc(32, 0x42)
const KEK_VERSION = 7
const KEYRING = new Map([[KEK_VERSION, KEK]])
const RETIRED_TABLES = ['credential_bindings', 'credential_versions', 'credential_fetch_intents', 'credential_devices', 'skill_env_shares', 'team_credential_migration_stage']

const ids = {
  author: '10000000-0000-4000-8000-000000000001',
  member: '10000000-0000-4000-8000-000000000002',
  teamSingle: '20000000-0000-4000-8000-000000000001',
  teamSame: '20000000-0000-4000-8000-000000000002',
  teamDiff: '20000000-0000-4000-8000-000000000003',
  teamRevoked: '20000000-0000-4000-8000-000000000004',
  skillA: '30000000-0000-4000-8000-000000000001',
  skillB: '30000000-0000-4000-8000-000000000002',
  bindingSingle: '40000000-0000-4000-8000-000000000001',
  bindingSameA: '40000000-0000-4000-8000-000000000002',
  bindingSameB: '40000000-0000-4000-8000-000000000003',
  bindingDiffOld: '40000000-0000-4000-8000-000000000004',
  bindingDiffNew: '40000000-0000-4000-8000-000000000005',
  bindingRevoked: '40000000-0000-4000-8000-000000000006',
  bindingUnpublished: '40000000-0000-4000-8000-000000000007',
}

const PLAINTEXTS = ['single-secret-value', 'shared-same-secret', 'older-different-secret', 'newer-different-secret', 'revoked-secret-value']

function databaseUrl(name: string): string {
  const url = new URL(postgresUrl ?? '')
  url.pathname = `/${name}`
  return url.toString()
}

function migrateDeploy(url: string, schemaPath: string): void {
  execFileSync(prismaBin, ['migrate', 'deploy', '--schema', schemaPath], {
    cwd: serverRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  })
}

function migrateDeployFails(url: string): string {
  try {
    migrateDeploy(url, join(serverRoot, 'prisma/schema.prisma'))
  } catch (error: unknown) {
    const output = error as { stdout?: Buffer; stderr?: Buffer }
    return `${output.stdout?.toString() ?? ''}${output.stderr?.toString() ?? ''}`
  }
  throw new Error('Expected prisma migrate deploy to fail')
}

async function tableExists(client: PrismaClient, table: string): Promise<boolean> {
  const rows = await client.$queryRawUnsafe<Array<{ present: boolean }>>(
    `SELECT to_regclass('public.${table}') IS NOT NULL AS "present"`
  )
  return rows[0]?.present === true
}

type BindingFixture = {
  id: string
  skillId: string
  teamId: string
  envKey: string
  revision: number
  status: 'active' | 'revoked'
  value: string | null
  versionCreatedAt: Date
}

async function insertLegacyFixtures(client: PrismaClient, bindings: BindingFixture[]): Promise<void> {
  await client.$executeRawUnsafe(`INSERT INTO "users" ("id", "email", "displayName", "updatedAt") VALUES
    ('${ids.author}', 'mig-author@example.com', 'Author', NOW()),
    ('${ids.member}', 'mig-member@example.com', 'Member', NOW())`)
  for (const teamId of [ids.teamSingle, ids.teamSame, ids.teamDiff, ids.teamRevoked]) {
    await client.$executeRawUnsafe(`INSERT INTO "teams" ("id", "name", "ownerId", "updatedAt") VALUES ('${teamId}', 'Team ${teamId.slice(-1)}', '${ids.author}', NOW())`)
  }
  for (const skillId of [ids.skillA, ids.skillB]) {
    await client.$executeRawUnsafe(`INSERT INTO "skills" ("id", "name", "displayName", "authorId", "updatedAt") VALUES ('${skillId}', 'skill-${skillId.slice(-1)}', 'Skill ${skillId.slice(-1)}', '${ids.author}', NOW())`)
  }
  for (const binding of bindings) {
    await client.$executeRaw`
      INSERT INTO "credential_bindings" ("id", "skillId", "teamId", "envKey", "status", "currentRevision", "createdById", "updatedAt", "revokedAt")
      VALUES (${binding.id}, ${binding.skillId}, ${binding.teamId}, ${binding.envKey}, ${binding.status}, ${binding.value ? binding.revision : 0},
              ${ids.author}, NOW(), ${binding.status === 'revoked' ? new Date() : null})
    `
    if (!binding.value) continue
    const encrypted = encryptLegacyBindingValue(binding.value, {
      bindingId: binding.id,
      skillId: binding.skillId,
      teamId: binding.teamId,
      envKey: binding.envKey,
      revision: binding.revision,
    }, KEK, KEK_VERSION)
    await client.$executeRaw`
      INSERT INTO "credential_versions" ("id", "bindingId", "revision", "ciphertext", "iv", "tag", "wrappedDek", "wrapIv", "wrapTag", "kekVersion", "aadVersion", "createdById", "createdAt")
      VALUES (${randomUUID()}, ${binding.id}, ${binding.revision}, ${encrypted.ciphertext}, ${encrypted.iv}, ${encrypted.tag}, ${encrypted.wrappedDek},
              ${encrypted.wrapIv}, ${encrypted.wrapTag}, ${encrypted.kekVersion}, ${encrypted.aadVersion}, ${ids.author}, ${binding.versionCreatedAt})
    `
  }
}

const MIXED_FIXTURES: BindingFixture[] = [
  { id: ids.bindingSingle, skillId: ids.skillA, teamId: ids.teamSingle, envKey: 'FAL_KEY', revision: 1, status: 'active', value: PLAINTEXTS[0] ?? '', versionCreatedAt: new Date('2026-09-01T00:00:00Z') },
  { id: ids.bindingSameA, skillId: ids.skillA, teamId: ids.teamSame, envKey: 'OPENAI_API_KEY', revision: 2, status: 'active', value: PLAINTEXTS[1] ?? '', versionCreatedAt: new Date('2026-09-02T00:00:00Z') },
  { id: ids.bindingSameB, skillId: ids.skillB, teamId: ids.teamSame, envKey: 'OPENAI_API_KEY', revision: 1, status: 'active', value: PLAINTEXTS[1] ?? '', versionCreatedAt: new Date('2026-09-03T00:00:00Z') },
  { id: ids.bindingDiffOld, skillId: ids.skillA, teamId: ids.teamDiff, envKey: 'HF_TOKEN', revision: 3, status: 'active', value: PLAINTEXTS[2] ?? '', versionCreatedAt: new Date('2026-09-04T00:00:00Z') },
  { id: ids.bindingDiffNew, skillId: ids.skillB, teamId: ids.teamDiff, envKey: 'HF_TOKEN', revision: 1, status: 'active', value: PLAINTEXTS[3] ?? '', versionCreatedAt: new Date('2026-09-05T00:00:00Z') },
  { id: ids.bindingRevoked, skillId: ids.skillA, teamId: ids.teamRevoked, envKey: 'REPLICATE_API_TOKEN', revision: 1, status: 'revoked', value: PLAINTEXTS[4] ?? '', versionCreatedAt: new Date('2026-09-06T00:00:00Z') },
  { id: ids.bindingUnpublished, skillId: ids.skillB, teamId: ids.teamRevoked, envKey: 'CO_API_KEY', revision: 0, status: 'active', value: null, versionCreatedAt: new Date('2026-09-07T00:00:00Z') },
]

function assertReportHasNoSecrets(report: MigrationReport): void {
  const serialized = JSON.stringify(report)
  for (const field of ['ciphertext', 'value', 'wrappedDek', 'iv', 'tag']) {
    expect(serialized).not.toMatch(new RegExp(`"${field}"`))
  }
  for (const plaintext of PLAINTEXTS) expect(serialized).not.toContain(plaintext)
}

describePostgres('team credential migration (real prisma migrate deploy)', () => {
  const suffix = `${process.pid}_${Date.now()}`
  const baseName = `skillhub_mig254_base_${suffix}`
  const created: string[] = []
  let admin: PrismaClient
  let previousSchemaDir: string

  async function cloneDatabase(label: string): Promise<{ url: string; client: PrismaClient }> {
    const name = `skillhub_mig254_${label}_${suffix}`
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${baseName}"`)
    created.push(name)
    const url = databaseUrl(name)
    return { url, client: new PrismaClient({ datasources: { db: { url } } }) }
  }

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: databaseUrl('postgres') } } })
    previousSchemaDir = mkdtempSync(join(tmpdir(), 'skillhub-mig254-'))
    cpSync(join(serverRoot, 'prisma/schema.prisma'), join(previousSchemaDir, 'schema.prisma'))
    // The "previous" schema is the state right before TARGET: every later
    // migration (e.g. 20261014120000_team_credential_aliases) builds on the
    // tables TARGET creates, so it is left out here and applied by the real
    // `migrate deploy` below together with TARGET.
    for (const entry of readdirSync(join(serverRoot, 'prisma/migrations'))) {
      if (entry >= TARGET) continue
      cpSync(join(serverRoot, 'prisma/migrations', entry), join(previousSchemaDir, 'migrations', entry), { recursive: true })
    }
    await admin.$executeRawUnsafe(`CREATE DATABASE "${baseName}"`)
    created.push(baseName)
    migrateDeploy(databaseUrl(baseName), join(previousSchemaDir, 'schema.prisma'))
  }, 180_000)

  afterAll(async () => {
    if (!admin) return
    for (const name of created.reverse()) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    }
    await admin.$disconnect()
    if (previousSchemaDir) rmSync(previousSchemaDir, { recursive: true, force: true })
  })

  it('migrates an empty legacy store and drops every retired table', async () => {
    const { url, client } = await cloneDatabase('empty')
    try {
      const report = await stageTeamCredentialMigration(client, { keyring: KEYRING, currentKek: KEK, currentKekVersion: KEK_VERSION })
      expect(report).toMatchObject({ legacyTablesPresent: true, activeBindings: 0, stagedCredentials: 0, conflicts: 0, groups: [] })
      migrateDeploy(url, join(serverRoot, 'prisma/schema.prisma'))
      for (const table of RETIRED_TABLES) expect(await tableExists(client, table)).toBe(false)
      expect(await client.teamCredential.count()).toBe(0)
      const rerun = await stageTeamCredentialMigration(client, { keyring: KEYRING, currentKek: KEK, currentKekVersion: KEK_VERSION })
      expect(rerun.legacyTablesPresent).toBe(false)
    } finally {
      await client.$disconnect()
    }
  }, 120_000)

  it('migrates single, same-value and different-value groups, skips revoked bindings, and reports conflicts without secrets', async () => {
    const { url, client } = await cloneDatabase('mixed')
    try {
      await insertLegacyFixtures(client, MIXED_FIXTURES)
      const report = await stageTeamCredentialMigration(client, { keyring: KEYRING, currentKek: KEK, currentKekVersion: KEK_VERSION })
      expect(report).toMatchObject({ activeBindings: 5, inactiveBindings: 2, stagedCredentials: 3, conflicts: 1 })
      assertReportHasNoSecrets(report)
      const diff = report.groups.find((group) => group.envKey === 'HF_TOKEN')
      expect(diff).toMatchObject({
        credentialId: ids.bindingDiffNew,
        holderId: ids.author,
        winner: { bindingId: ids.bindingDiffNew, skillId: ids.skillB },
        merged: [],
        discarded: [{ bindingId: ids.bindingDiffOld, skillId: ids.skillA }],
      })
      const same = report.groups.find((group) => group.envKey === 'OPENAI_API_KEY')
      expect(same?.merged).toEqual([{ bindingId: ids.bindingSameA, skillId: ids.skillA }])
      expect(same?.discarded).toEqual([])

      migrateDeploy(url, join(serverRoot, 'prisma/schema.prisma'))

      for (const table of RETIRED_TABLES) expect(await tableExists(client, table)).toBe(false)
      const columns = await client.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'credential_audit_events'
      `
      expect(columns.map((column) => column.column_name)).not.toContain('intentId')

      const credentials = await client.teamCredential.findMany({ include: { versions: true }, orderBy: { envKey: 'asc' } })
      expect(credentials.map((credential) => [credential.teamId, credential.envKey, credential.status, credential.currentRevision, credential.createdById])).toEqual([
        [ids.teamSingle, 'FAL_KEY', 'active', 1, ids.author],
        [ids.teamDiff, 'HF_TOKEN', 'active', 1, ids.author],
        [ids.teamSame, 'OPENAI_API_KEY', 'active', 1, ids.author],
      ])
      const decrypted = credentials.map((credential) => {
        const version = credential.versions[0]
        if (!version) throw new Error('missing version')
        expect(version.aadVersion).toBe(2)
        return decryptCredentialValue(version, {
          credentialId: credential.id,
          teamId: credential.teamId,
          envKey: credential.envKey,
          revision: credential.currentRevision,
        }, KEYRING)
      })
      // Every migrated key decrypts under the new team AAD; count = expected groups.
      expect(decrypted).toEqual([PLAINTEXTS[0], PLAINTEXTS[3], PLAINTEXTS[1]])
    } finally {
      await client.$disconnect()
    }
  }, 120_000)

  it('refuses to run without the stage step and leaves the legacy tables intact', async () => {
    const { url, client } = await cloneDatabase('unstaged')
    try {
      await insertLegacyFixtures(client, MIXED_FIXTURES)
      const output = migrateDeployFails(url)
      expect(output).toContain('are not staged')
      expect(await tableExists(client, 'credential_bindings')).toBe(true)
      expect(await tableExists(client, 'team_credentials')).toBe(false)
      // The migration's first statement (CREATE TABLE IF NOT EXISTS stage)
      // was rolled back too: the whole file runs as one transaction.
      expect(await tableExists(client, 'team_credential_migration_stage')).toBe(false)
      const count = await client.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS "count" FROM "credential_bindings"`
      expect(count[0]?.count).toBe(MIXED_FIXTURES.length)
    } finally {
      await client.$disconnect()
    }
  }, 120_000)

  it('refuses a stale stage when a binding was rotated after staging', async () => {
    const { url, client } = await cloneDatabase('stale')
    try {
      await insertLegacyFixtures(client, MIXED_FIXTURES)
      await stageTeamCredentialMigration(client, { keyring: KEYRING, currentKek: KEK, currentKekVersion: KEK_VERSION })
      await client.$executeRaw`UPDATE "credential_bindings" SET "currentRevision" = "currentRevision" + 1 WHERE "id" = ${ids.bindingSingle}`
      const output = migrateDeployFails(url)
      expect(output).toMatch(/not staged|changed after staging/)
      expect(await tableExists(client, 'credential_bindings')).toBe(true)
      expect(await tableExists(client, 'team_credentials')).toBe(false)
    } finally {
      await client.$disconnect()
    }
  }, 120_000)
})
