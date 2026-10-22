-- Marketplace reviewer authority is read from the database on every authenticated
-- request so demotion takes effect without waiting for an existing JWT to expire.
ALTER TABLE "users"
ADD COLUMN "marketplaceRole" TEXT NOT NULL DEFAULT 'user';

-- Marketplace approval is bound to an exact version. Existing current versions
-- receive the already-redacted Skill source when it is available; older versions
-- remain ineligible until the owner uploads a fresh, reviewable version.
ALTER TABLE "skill_versions"
ADD COLUMN "profileSnapshotVersion" INTEGER,
ADD COLUMN "skillName" TEXT,
ADD COLUMN "displayName" TEXT,
ADD COLUMN "description" TEXT,
ADD COLUMN "category" TEXT,
ADD COLUMN "labels" JSONB,
ADD COLUMN "triggerScenarios" JSONB,
ADD COLUMN "compatibleAgents" JSONB,
ADD COLUMN "envDependencies" JSONB,
ADD COLUMN "sourceContent" TEXT;

UPDATE "skill_versions" AS version
SET "profileSnapshotVersion" = CASE
      WHEN skill."sourceContent" IS NOT NULL THEN 1
      ELSE NULL
    END,
    "skillName" = skill."name",
    "displayName" = skill."displayName",
    "description" = skill."description",
    "category" = skill."category",
    "labels" = skill."labels",
    "triggerScenarios" = skill."triggerScenarios",
    "compatibleAgents" = skill."compatibleAgents",
    "envDependencies" = skill."envDependencies",
    "sourceContent" = skill."sourceContent"
FROM "skills" AS skill
WHERE version."skillId" = skill."id"
  AND version."version" = skill."currentVersion"
  AND version."profileSnapshotVersion" IS NULL;

CREATE TABLE "marketplace_submissions" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "submittedById" TEXT NOT NULL,
    "reviewerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "submitterNote" TEXT,
    "reviewNote" TEXT,
    "skillName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "labels" JSONB NOT NULL DEFAULT '[]',
    "triggerScenarios" JSONB NOT NULL DEFAULT '[]',
    "compatibleAgents" JSONB NOT NULL DEFAULT '[]',
    "envDependencies" JSONB NOT NULL DEFAULT '[]',
    "sourceContent" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewStartedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),

    CONSTRAINT "marketplace_submissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "marketplace_listings" (
    "skillId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "withdrawnAt" TIMESTAMP(3),

    CONSTRAINT "marketplace_listings_pkey" PRIMARY KEY ("skillId")
);

CREATE INDEX "marketplace_submissions_status_submittedAt_idx"
ON "marketplace_submissions"("status", "submittedAt");

CREATE INDEX "marketplace_submissions_skillId_submittedAt_idx"
ON "marketplace_submissions"("skillId", "submittedAt");

-- Application writers also acquire the Skill advisory lock. This database
-- invariant protects against accidental duplicate active reviews from scripts.
CREATE UNIQUE INDEX "marketplace_submissions_one_active_per_skill"
ON "marketplace_submissions"("skillId")
WHERE "status" IN ('submitted', 'under_review');

CREATE UNIQUE INDEX "marketplace_listings_submissionId_key"
ON "marketplace_listings"("submissionId");

CREATE INDEX "marketplace_listings_withdrawnAt_publishedAt_idx"
ON "marketplace_listings"("withdrawnAt", "publishedAt");

CREATE INDEX "marketplace_listings_withdrawnAt_downloadCount_idx"
ON "marketplace_listings"("withdrawnAt", "downloadCount");

ALTER TABLE "marketplace_submissions"
ADD CONSTRAINT "marketplace_submissions_skillId_fkey"
FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "marketplace_submissions"
ADD CONSTRAINT "marketplace_submissions_versionId_fkey"
FOREIGN KEY ("versionId") REFERENCES "skill_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "marketplace_submissions"
ADD CONSTRAINT "marketplace_submissions_submittedById_fkey"
FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "marketplace_submissions"
ADD CONSTRAINT "marketplace_submissions_reviewerId_fkey"
FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "marketplace_listings"
ADD CONSTRAINT "marketplace_listings_skillId_fkey"
FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "marketplace_listings"
ADD CONSTRAINT "marketplace_listings_submissionId_fkey"
FOREIGN KEY ("submissionId") REFERENCES "marketplace_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "marketplace_listings"
ADD CONSTRAINT "marketplace_listings_versionId_fkey"
FOREIGN KEY ("versionId") REFERENCES "skill_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
