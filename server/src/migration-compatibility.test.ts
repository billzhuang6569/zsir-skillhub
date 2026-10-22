import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const LEGACY_CHALLENGE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const migrationUrl = new URL(
  '../prisma/migrations/20260803223000_add_credential_device_proof/migration.sql',
  import.meta.url
)
const skillSoftDeleteMigrationUrl = new URL(
  '../prisma/migrations/20260804020000_add_skill_soft_delete/migration.sql',
  import.meta.url
)
const marketplaceMigrationUrl = new URL(
  '../prisma/migrations/20260804100000_add_marketplace/migration.sql',
  import.meta.url
)
const yitanIdentityMigrationUrl = new URL(
  '../prisma/migrations/20260913193000_add_yitan_external_identity/migration.sql',
  import.meta.url
)
const oidcLogoutWatermarkMigrationUrl = new URL(
  '../prisma/migrations/20260913213000_add_oidc_logout_watermark/migration.sql',
  import.meta.url
)
const schemaUrl = new URL('../prisma/schema.prisma', import.meta.url)

describe('credential device migration compatibility', () => {
  it('kept legacy intent inserts valid until the table was retired by #254', () => {
    const migration = readFileSync(migrationUrl, 'utf8')
    const schema = readFileSync(schemaUrl, 'utf8')

    expect(Buffer.from(LEGACY_CHALLENGE, 'base64url')).toHaveLength(32)
    expect(migration).toContain(
      `ADD COLUMN "challenge" TEXT DEFAULT '${LEGACY_CHALLENGE}'`
    )
    expect(migration).toContain('ALTER COLUMN "challenge" SET NOT NULL')
    expect(schema).not.toMatch(/model CredentialFetchIntent\s+\{/)
    expect(schema).not.toMatch(/model CredentialDevice\s+\{/)
  })
})

describe('Team key vault migration compatibility', () => {
  const teamCredentialMigration = readFileSync(
    new URL('../prisma/migrations/20261013200000_team_credentials/migration.sql', import.meta.url),
    'utf8'
  )

  it('guards on the staged data move before creating, copying and dropping', () => {
    const guardAt = teamCredentialMigration.indexOf('RAISE EXCEPTION \'team_credentials: % active credential binding(s) are not staged')
    const staleAt = teamCredentialMigration.indexOf('changed after staging')
    const createAt = teamCredentialMigration.indexOf('CREATE TABLE "team_credentials"')
    const copyAt = teamCredentialMigration.indexOf('INSERT INTO "team_credentials"')
    const dropStageAt = teamCredentialMigration.indexOf('DROP TABLE "team_credential_migration_stage"')
    const dropLegacyAt = teamCredentialMigration.indexOf('DROP TABLE "credential_bindings"')
    expect(guardAt).toBeGreaterThan(0)
    expect(staleAt).toBeGreaterThan(guardAt)
    expect(createAt).toBeGreaterThan(staleAt)
    expect(copyAt).toBeGreaterThan(createAt)
    expect(dropStageAt).toBeGreaterThan(copyAt)
    expect(dropLegacyAt).toBeGreaterThan(dropStageAt)
    for (const table of ['credential_versions', 'credential_bindings', 'credential_fetch_intents', 'credential_devices', 'skill_env_shares']) {
      expect(teamCredentialMigration).toContain(`DROP TABLE "${table}";`)
    }
    expect(teamCredentialMigration).toContain('ALTER TABLE "credential_audit_events" DROP COLUMN "intentId"')
    // One implicit transaction: no explicit transaction control that would split it.
    expect(teamCredentialMigration).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im)
  })

  it('removes the retired models from the Prisma schema', () => {
    const schema = readFileSync(schemaUrl, 'utf8')
    for (const model of ['CredentialBinding', 'CredentialVersion', 'CredentialFetchIntent', 'CredentialDevice', 'SkillEnvShare']) {
      expect(schema).not.toMatch(new RegExp(`model ${model}\\s+\\{`))
    }
    expect(schema).toMatch(/model TeamCredential\s+\{/)
    expect(schema).toMatch(/@@unique\(\[teamId, envKey\]\)/)
    expect(schema).toMatch(/model TeamCredentialExclusion\s+\{/)
  })
})

describe('Skill soft-delete migration compatibility', () => {
  it('normalizes the legacy display-only version and replaces active-name uniqueness without deleting rows', () => {
    const migration = readFileSync(skillSoftDeleteMigrationUrl, 'utf8')
    const schema = readFileSync(schemaUrl, 'utf8')

    const addTombstoneAt = migration.indexOf('ADD COLUMN "deletedAt" TIMESTAMP(3)')
    const createActiveUniqueAt = migration.indexOf(
      'CREATE UNIQUE INDEX "skills_authorId_name_active_key"'
    )
    const dropLegacyUniqueAt = migration.indexOf(
      'DROP INDEX IF EXISTS "skills_authorId_name_key"'
    )

    expect(addTombstoneAt).toBeGreaterThanOrEqual(0)
    expect(createActiveUniqueAt).toBeGreaterThan(addTombstoneAt)
    expect(dropLegacyUniqueAt).toBeGreaterThan(createActiveUniqueAt)
    expect(migration).toContain('WHERE "deletedAt" IS NULL')
    expect(migration).toContain('ALTER COLUMN "currentVersion" SET DEFAULT \'v0.1.0\'')
    expect(migration).toContain('UPDATE "skill_versions" AS legacy')
    expect(migration).toContain('SET "version" = \'v0.1.0\'')
    expect(migration).toContain('SET "version" = \'v0.1.0-legacy-\' || LEFT("id", 8)')
    expect(migration).toContain('UPDATE "skills"')
    expect(migration).toContain('WHERE "currentVersion" = \'未版本化\'')
    expect(migration).not.toMatch(/^\s*(?:DELETE|TRUNCATE)\b/m)
    expect(schema).toContain('deletedAt         DateTime?')
    expect(schema).toMatch(/currentVersion\s+String\s+@default\("0\.1\.0"\)/)
    expect(schema).toContain('@@index([authorId, name])')
    expect(schema).not.toContain('@@unique([authorId, name])')
  })
})

describe('Marketplace migration compatibility', () => {
  it('pins review snapshots to exact versions and prevents raced active submissions', () => {
    const migration = readFileSync(marketplaceMigrationUrl, 'utf8')
    const schema = readFileSync(schemaUrl, 'utf8')

    expect(migration).toContain('ADD COLUMN "marketplaceRole" TEXT NOT NULL DEFAULT \'user\'')
    expect(migration).toContain('ADD COLUMN "sourceContent" TEXT')
    expect(migration).toContain('ADD COLUMN "profileSnapshotVersion" INTEGER')
    expect(migration).toContain('"skillName" = skill."name"')
    expect(migration).toContain('"displayName" = skill."displayName"')
    expect(migration).toContain('"labels" = skill."labels"')
    expect(migration).toContain('"envDependencies" = skill."envDependencies"')
    expect(migration).toContain('WHEN skill."sourceContent" IS NOT NULL THEN 1')
    expect(migration).toContain('CREATE TABLE "marketplace_submissions"')
    expect(migration).toContain('CREATE TABLE "marketplace_listings"')
    expect(migration).toContain('CREATE UNIQUE INDEX "marketplace_submissions_one_active_per_skill"')
    expect(migration).toContain('WHERE "status" IN (\'submitted\', \'under_review\')')
    expect(migration).toContain('FOREIGN KEY ("versionId") REFERENCES "skill_versions"("id")')
    expect(migration).not.toMatch(/^\s*(?:DELETE|TRUNCATE)\b/m)

    expect(schema).toMatch(/marketplaceRole\s+String\s+@default\("user"\)/)
    expect(schema).toMatch(/model MarketplaceSubmission\s+\{/)
    expect(schema).toMatch(/model MarketplaceListing\s+\{/)
    expect(schema).toMatch(/profileSnapshotVersion\s+Int\?\s+\/\/ 1 means the complete public Profile/)
    expect(schema).toMatch(/skillName\s+String\?/)
    expect(schema).toMatch(/envDependencies\s+Json\?/)
    expect(schema).toMatch(/sourceContent\s+String\?\s+@db\.Text \/\/ redacted SKILL\.md snapshot/)
  })
})

describe('Yitan external identity migration compatibility', () => {
  it('adds an identity mapping without replacing local users or deleting business data', () => {
    const migration = readFileSync(yitanIdentityMigrationUrl, 'utf8')
    const schema = readFileSync(schemaUrl, 'utf8')

    expect(migration).toContain('CREATE TABLE "external_identities"')
    expect(migration).toContain('"lastLogoutAt" TIMESTAMP(3)')
    expect(migration).toContain('CREATE UNIQUE INDEX "external_identities_issuer_subject_key"')
    expect(migration).toContain('CREATE UNIQUE INDEX "external_identities_userId_issuer_key"')
    expect(migration).toContain('FOREIGN KEY ("userId") REFERENCES "users"("id")')
    expect(migration).not.toMatch(/^\s*(?:DELETE|TRUNCATE|DROP)\b/m)
    expect(schema).toMatch(/model ExternalIdentity\s+\{/)
    expect(schema).toMatch(/@@unique\(\[issuer, subject\]\)/)
    expect(schema).toMatch(/@@unique\(\[userId, issuer\]\)/)
    expect(schema).toMatch(/lastLogoutAt\s+DateTime\?/)
  })

  it('adds an independent logout watermark and only backfills existing revocation state', () => {
    const migration = readFileSync(oidcLogoutWatermarkMigrationUrl, 'utf8')
    const schema = readFileSync(schemaUrl, 'utf8')

    expect(migration).toContain('CREATE TABLE "oidc_logout_watermarks"')
    expect(migration).toContain('PRIMARY KEY ("issuer", "subject")')
    expect(migration).toContain('MAX("lastLogoutAt")')
    expect(migration).toContain('FROM "external_identities"')
    expect(migration).toContain('ON CONFLICT ("issuer", "subject") DO UPDATE')
    expect(migration).toContain('GREATEST(')
    expect(migration).toContain('CREATE FUNCTION "sync_oidc_logout_watermark_from_identity"()')
    expect(migration).toContain('AFTER INSERT OR UPDATE OF "lastLogoutAt"')
    expect(migration).toContain('CREATE TRIGGER "external_identities_sync_logout_watermark"')
    expect(migration).not.toMatch(/^\s*(?:DELETE|TRUNCATE|DROP|UPDATE\s+"users")\b/m)
    expect(schema).toMatch(/model OidcLogoutWatermark\s+\{/)
    expect(schema).toMatch(/@@id\(\[issuer, subject\]\)/)
    expect(schema).toMatch(/latestLogoutAt\s+DateTime/)
  })
})

describe('Skill card library migration compatibility', () => {
  it('only adds tables, a nullable column and indexes so the previous release keeps running', () => {
    const migration = readFileSync(
      new URL('../prisma/migrations/20261004000000_add_skill_cards_library/migration.sql', import.meta.url),
      'utf8'
    )
    expect(migration).toContain('ALTER TABLE "skill_versions" ADD COLUMN     "cardSha256" TEXT;')
    expect(migration).not.toMatch(/\bDROP\b|\bRENAME\b|SET NOT NULL|^\s*(?:UPDATE|DELETE|TRUNCATE)\b/m)
    expect(migration.match(/ALTER TABLE "skill_versions"/g)).toHaveLength(2)
    expect(migration).toContain('REFERENCES "skill_cards"("sha256") ON DELETE RESTRICT')
  })
})
