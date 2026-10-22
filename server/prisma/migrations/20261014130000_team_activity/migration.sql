-- Team activity feed (#293): one row per member join/leave/removal, Skill
-- share/unshare/new version and team key put/rotate/revoke. Payload carries
-- names and ids only, never key values, ciphertext, emails or tokens.
-- Deleting a user keeps the row with a null actor. Additive only.

-- CreateTable
CREATE TABLE "team_activities" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "team_activities_teamId_createdAt_idx" ON "team_activities"("teamId", "createdAt");

-- AddForeignKey
ALTER TABLE "team_activities" ADD CONSTRAINT "team_activities_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_activities" ADD CONSTRAINT "team_activities_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

