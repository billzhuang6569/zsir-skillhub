ALTER TABLE "skill_team_shares" ADD COLUMN "versionId" TEXT;
UPDATE "skill_team_shares" AS share
SET "versionId" = version.id
FROM "skills" AS skill, "skill_versions" AS version
WHERE share."skillId" = skill.id AND version."skillId" = skill.id
  AND version.version = skill."currentVersion";
ALTER TABLE "skill_team_shares" ADD CONSTRAINT "skill_team_shares_versionId_fkey"
  FOREIGN KEY ("versionId") REFERENCES "skill_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
CREATE INDEX "skill_team_shares_versionId_idx" ON "skill_team_shares"("versionId");
CREATE TABLE "team_skill_acquisitions" (
  "skillId" TEXT NOT NULL, "teamId" TEXT NOT NULL, "userId" TEXT NOT NULL, "versionId" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "team_skill_acquisitions_pkey" PRIMARY KEY ("skillId", "teamId", "userId", "versionId")
);
INSERT INTO "team_skill_acquisitions" ("skillId", "teamId", "userId", "versionId")
SELECT DISTINCT entry."sourceSkillId", share."teamId", entry."userId", COALESCE(entry."sourceVersionId", '')
FROM "library_entries" entry
JOIN "skill_team_shares" share ON share."skillId" = entry."sourceSkillId"
JOIN "team_members" member ON member."teamId" = share."teamId" AND member."userId" = entry."userId"
WHERE entry."sourceKind" = 'team' AND entry."deletedAt" IS NULL
ON CONFLICT DO NOTHING;
