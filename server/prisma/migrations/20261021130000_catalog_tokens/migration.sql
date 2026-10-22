ALTER TABLE "users" ADD COLUMN "catalogTokenVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "catalog_skill_sources" (
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sourceOrigin" TEXT NOT NULL,
  "sourceSkillId" TEXT NOT NULL,
  "skillId" TEXT NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY ("userId", "sourceOrigin", "sourceSkillId")
);
CREATE TABLE "catalog_submission_operations" (
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "clientOperationId" TEXT NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "submissionId" TEXT NOT NULL REFERENCES "marketplace_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY ("userId", "clientOperationId")
);
