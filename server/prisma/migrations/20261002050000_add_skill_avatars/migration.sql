ALTER TABLE "skills" ADD COLUMN "avatarUrl" TEXT;
ALTER TABLE "skills" ADD COLUMN "avatarStatus" TEXT NOT NULL DEFAULT 'none';

CREATE TABLE "skill_avatars" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "localSkillId" TEXT,
  "skillId" TEXT,
  "input" JSONB NOT NULL,
  "inputFingerprint" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "prompt" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "requestId" TEXT,
  "submittedAt" TIMESTAMP(3),
  "imageUrl" TEXT,
  "imageData" BYTEA,
  "imageSha256" TEXT,
  "assetId" TEXT,
  "url" TEXT,
  "errorCode" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "skill_avatars_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "skill_avatars_status_check" CHECK ("status" IN ('queued', 'prompting', 'submitting', 'awaiting', 'transferring', 'ready', 'failed', 'needs_review')),
  CONSTRAINT "skill_avatars_identity_check" CHECK ("localSkillId" IS NOT NULL OR "skillId" IS NOT NULL),
  CONSTRAINT "skill_avatars_ready_check" CHECK ("status" <> 'ready' OR ("assetId" IS NOT NULL AND "url" IS NOT NULL)),
  CONSTRAINT "skill_avatars_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "skill_avatars_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "skill_avatars_skillId_key" ON "skill_avatars"("skillId");
CREATE UNIQUE INDEX "skill_avatars_requestId_key" ON "skill_avatars"("requestId");
CREATE UNIQUE INDEX "skill_avatars_ownerId_localSkillId_key" ON "skill_avatars"("ownerId", "localSkillId");
CREATE INDEX "skill_avatars_status_nextAttemptAt_leaseUntil_idx" ON "skill_avatars"("status", "nextAttemptAt", "leaseUntil");
