-- Team key vault (#254): replace per-(Skill, team, KEY) credential bindings
-- with one value per (team, KEY), then drop every retired credential table in
-- the same migration. There is no compatibility layer and no residue.
--
-- Values are re-encrypted under the new AAD {credentialId, teamId, envKey,
-- revision}. SQL cannot decrypt, so the release runs
--   node dist/ops/team-credentials-migration.js stage --report <file>
-- immediately BEFORE `prisma migrate deploy`. That step decrypts every active
-- binding with the KEK keyring, groups by (teamId, envKey), re-encrypts the
-- winning value and writes it to "team_credential_migration_stage". This
-- migration only copies staged rows, refuses to run when any active binding
-- is missing from (or changed since) the stage, and drops the stage table.
-- PostgreSQL runs this multi-statement script in one implicit transaction:
-- a failed guard leaves every legacy table untouched.
--
-- Rollback is a restore of the pre-release database backup only; reverting
-- code cannot bring the dropped tables back.

-- The stage step creates this exact table; databases without legacy data
-- (fresh installs, CI) get an empty one here.
CREATE TABLE IF NOT EXISTS "team_credential_migration_stage" (
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
    CONSTRAINT "team_credential_migration_stage_pkey" PRIMARY KEY ("credentialId")
);

-- Guard: every active, published binding must be staged at its current
-- revision, and every staged source must still be that active binding.
DO $$
DECLARE
    unstaged INTEGER;
    stale INTEGER;
    invalid INTEGER;
BEGIN
    SELECT COUNT(*) INTO unstaged
    FROM "credential_bindings" AS binding
    WHERE binding."status" = 'active'
      AND binding."currentRevision" > 0
      AND NOT EXISTS (
          SELECT 1
          FROM "team_credential_migration_stage" AS stage,
               unnest(stage."sourceBindingIds", stage."sourceRevisions") AS source("bindingId", "revision")
          WHERE stage."teamId" = binding."teamId"
            AND stage."envKey" = binding."envKey"
            AND source."bindingId" = binding."id"
            AND source."revision" = binding."currentRevision"
      );
    IF unstaged > 0 THEN
        RAISE EXCEPTION 'team_credentials: % active credential binding(s) are not staged; run dist/ops/team-credentials-migration.js stage right before prisma migrate deploy', unstaged;
    END IF;

    SELECT COUNT(*) INTO stale
    FROM "team_credential_migration_stage" AS stage,
         unnest(stage."sourceBindingIds", stage."sourceRevisions") AS source("bindingId", "revision")
    WHERE NOT EXISTS (
        SELECT 1
        FROM "credential_bindings" AS binding
        WHERE binding."id" = source."bindingId"
          AND binding."teamId" = stage."teamId"
          AND binding."envKey" = stage."envKey"
          AND binding."status" = 'active'
          AND binding."currentRevision" = source."revision"
    );
    IF stale > 0 THEN
        RAISE EXCEPTION 'team_credentials: % staged source(s) changed after staging; re-run the stage step', stale;
    END IF;

    SELECT COUNT(*) INTO invalid
    FROM "team_credential_migration_stage"
    WHERE "aadVersion" <> 2
       OR "status" NOT IN ('active', 'revoked')
       OR cardinality("sourceBindingIds") = 0
       OR cardinality("sourceBindingIds") <> cardinality("sourceRevisions");
    IF invalid > 0 THEN
        RAISE EXCEPTION 'team_credentials: % staged row(s) are malformed', invalid;
    END IF;
END $$;

-- CreateTable
CREATE TABLE "team_credentials" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "envKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currentRevision" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "team_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_credential_versions" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "wrapIv" BYTEA NOT NULL,
    "wrapTag" BYTEA NOT NULL,
    "kekVersion" INTEGER NOT NULL,
    "aadVersion" INTEGER NOT NULL DEFAULT 2,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_credential_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_credential_exclusions" (
    "credentialId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_credential_exclusions_pkey" PRIMARY KEY ("credentialId","skillId")
);

-- CreateIndex
CREATE INDEX "team_credentials_teamId_status_idx" ON "team_credentials"("teamId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "team_credentials_teamId_envKey_key" ON "team_credentials"("teamId", "envKey");

-- CreateIndex
CREATE INDEX "team_credential_versions_createdAt_idx" ON "team_credential_versions"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "team_credential_versions_credentialId_revision_key" ON "team_credential_versions"("credentialId", "revision");

-- CreateIndex
CREATE INDEX "team_credential_exclusions_skillId_idx" ON "team_credential_exclusions"("skillId");

-- AddForeignKey
ALTER TABLE "team_credentials" ADD CONSTRAINT "team_credentials_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_credentials" ADD CONSTRAINT "team_credentials_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_credential_versions" ADD CONSTRAINT "team_credential_versions_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "team_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_credential_versions" ADD CONSTRAINT "team_credential_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_credential_exclusions" ADD CONSTRAINT "team_credential_exclusions_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "team_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_credential_exclusions" ADD CONSTRAINT "team_credential_exclusions_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_credential_exclusions" ADD CONSTRAINT "team_credential_exclusions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Migrate staged team keys: one credential (revision 1) per (teamId, envKey).
INSERT INTO "team_credentials" (
    "id", "teamId", "envKey", "status", "currentRevision", "createdById", "createdAt", "updatedAt", "revokedAt"
)
SELECT
    "credentialId", "teamId", "envKey", "status", 1, "createdById", "createdAt", CURRENT_TIMESTAMP, "revokedAt"
FROM "team_credential_migration_stage";

INSERT INTO "team_credential_versions" (
    "id", "credentialId", "revision", "ciphertext", "iv", "tag", "wrappedDek", "wrapIv", "wrapTag",
    "kekVersion", "aadVersion", "createdById", "createdAt"
)
SELECT
    "versionId", "credentialId", 1, "ciphertext", "iv", "tag", "wrappedDek", "wrapIv", "wrapTag",
    "kekVersion", "aadVersion", "versionCreatedById", CURRENT_TIMESTAMP
FROM "team_credential_migration_stage";

DROP TABLE "team_credential_migration_stage";

-- Retire the per-Skill binding model and the unused device/intent/legacy
-- env-share tables.
ALTER TABLE "credential_audit_events" DROP CONSTRAINT "credential_audit_events_intentId_fkey";
DROP INDEX "credential_audit_events_intentId_idx";
ALTER TABLE "credential_audit_events" DROP COLUMN "intentId";

DROP TABLE "credential_versions";
DROP TABLE "credential_bindings";
DROP TABLE "credential_fetch_intents";
DROP TABLE "credential_devices";
DROP TABLE "skill_env_shares";
