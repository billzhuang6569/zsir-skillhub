ALTER TABLE "skills" ADD COLUMN "profileManuallyEdited" BOOLEAN NOT NULL DEFAULT false;

-- Protect historical metadata: without a complete snapshot, prefer skipping AI to losing user edits.
UPDATE "skills" s SET "profileManuallyEdited" = true
WHERE s."analysisStatus" = 'unanalysed' AND (
  NOT EXISTS (SELECT 1 FROM "skill_versions" v WHERE v."skillId" = s.id AND v."profileSnapshotVersion" = 1)
  OR EXISTS (
    SELECT 1 FROM "skill_versions" v
    WHERE v."skillId" = s.id AND v."profileSnapshotVersion" = 1
      AND (v.id = s."importVersionId" OR v.id = (
        SELECT latest.id FROM "skill_versions" latest WHERE latest."skillId" = s.id
          AND latest."profileSnapshotVersion" = 1 ORDER BY latest."createdAt" DESC, latest.id DESC LIMIT 1))
      AND (s."displayName" IS DISTINCT FROM v."displayName" OR s.description IS DISTINCT FROM v.description
        OR s.category IS DISTINCT FROM v.category OR s."triggerScenarios" IS DISTINCT FROM v."triggerScenarios")
  )
);
UPDATE "skills" SET "labelsManuallyEdited" = true
WHERE "analysisStatus" = 'unanalysed' AND jsonb_typeof(labels) = 'array' AND labels <> '[]'::jsonb;

CREATE INDEX "skills_enrichment_candidates_idx" ON "skills"("id")
WHERE "analysisStatus" = 'unanalysed' AND "deletedAt" IS NULL AND "avatarUrl" IS NULL;

CREATE TABLE "skill_enrichments" (
  "skillId" TEXT NOT NULL PRIMARY KEY,
  "phase" TEXT NOT NULL DEFAULT 'analysis',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "awaitingAnalysis" BOOLEAN NOT NULL DEFAULT false,
  "errorCode" TEXT,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  CONSTRAINT "skill_enrichments_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "skill_enrichments_phase_nextAttemptAt_idx" ON "skill_enrichments"("phase", "nextAttemptAt");
