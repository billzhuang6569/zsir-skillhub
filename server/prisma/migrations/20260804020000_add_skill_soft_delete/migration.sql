-- Add the nullable tombstone first. Every existing Skill remains active.
ALTER TABLE "skills"
ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Every newly managed Skill starts with a real semantic version.
ALTER TABLE "skills"
ALTER COLUMN "currentVersion" SET DEFAULT 'v0.1.0';

-- Early desktop builds sent the display-only label "未版本化" as a real
-- version. Normalize both sides of the Skill/SkillVersion contract so an
-- existing local asset upgraded to v0.1.0 still resolves its server package.
UPDATE "skill_versions" AS legacy
SET "version" = 'v0.1.0'
WHERE legacy."version" = '未版本化'
  AND NOT EXISTS (
    SELECT 1
    FROM "skill_versions" AS current
    WHERE current."skillId" = legacy."skillId"
      AND current."version" = 'v0.1.0'
  );

-- A defensive collision case preserves both historical rows without deleting
-- data. The already-existing v0.1.0 remains current; the legacy row keeps a
-- stable, unique recovery label derived from its immutable UUID.
UPDATE "skill_versions"
SET "version" = 'v0.1.0-legacy-' || LEFT("id", 8)
WHERE "version" = '未版本化';

UPDATE "skills"
SET "currentVersion" = 'v0.1.0'
WHERE "currentVersion" = '未版本化';

-- Build the replacement uniqueness guarantee before removing the legacy one,
-- so there is never a deployment window where two active Skills can collide.
CREATE UNIQUE INDEX "skills_authorId_name_active_key"
ON "skills"("authorId", "name")
WHERE "deletedAt" IS NULL;

-- Prisma 5 cannot describe a partial index in schema.prisma. These ordinary
-- indexes keep modeled lookups efficient; the partial unique index above stays
-- owned by this PostgreSQL migration.
CREATE INDEX "skills_authorId_name_idx" ON "skills"("authorId", "name");
CREATE INDEX "skills_authorId_deletedAt_idx" ON "skills"("authorId", "deletedAt");

-- Existing data already satisfies this constraint, so replacing it is lossless.
DROP INDEX IF EXISTS "skills_authorId_name_key";
