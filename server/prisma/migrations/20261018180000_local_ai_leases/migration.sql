CREATE TABLE "local_ai_leases" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "type" TEXT NOT NULL CHECK ("type" IN ('analyzeSkill', 'draftAvatarPrompt')),
    "inputHash" TEXT NOT NULL,
    "configVersion" TEXT NOT NULL,
    "tokenVersion" INTEGER NOT NULL,
    "state" TEXT NOT NULL CHECK ("state" IN ('leased', 'failed')),
    "failureCount" INTEGER NOT NULL DEFAULT 0 CHECK ("failureCount" >= 0),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "local_ai_leases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "local_ai_leases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "local_ai_leases_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "local_ai_leases_skillId_type_key" ON "local_ai_leases"("skillId", "type");
CREATE INDEX "local_ai_leases_userId_expiresAt_idx" ON "local_ai_leases"("userId", "expiresAt");
