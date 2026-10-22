-- AlterTable
ALTER TABLE "skill_versions" ADD COLUMN     "cardSha256" TEXT;

-- CreateTable
CREATE TABLE "skill_cards" (
    "sha256" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "executablePaths" JSONB NOT NULL DEFAULT '[]',
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_cards_pkey" PRIMARY KEY ("sha256")
);

-- CreateTable
CREATE TABLE "skill_card_grants" (
    "userId" TEXT NOT NULL,
    "cardSha256" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_card_grants_pkey" PRIMARY KEY ("userId","cardSha256")
);

-- CreateTable
CREATE TABLE "library_entries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cardSha256" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "profile" JSONB NOT NULL DEFAULT '{}',
    "sourceKind" TEXT NOT NULL DEFAULT 'local',
    "sourceSkillId" TEXT,
    "sourceVersionId" TEXT,
    "authorSkillId" TEXT,
    "migrationKey" TEXT,
    "requestDigest" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedByDevice" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "library_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "skill_cards_createdById_idx" ON "skill_cards"("createdById");

-- CreateIndex
CREATE INDEX "skill_card_grants_cardSha256_idx" ON "skill_card_grants"("cardSha256");

-- CreateIndex
CREATE INDEX "library_entries_userId_deletedAt_idx" ON "library_entries"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "library_entries_cardSha256_idx" ON "library_entries"("cardSha256");

-- CreateIndex
CREATE UNIQUE INDEX "library_entries_userId_migrationKey_key" ON "library_entries"("userId", "migrationKey");

-- CreateIndex
CREATE INDEX "skill_versions_cardSha256_idx" ON "skill_versions"("cardSha256");

-- AddForeignKey
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_cardSha256_fkey" FOREIGN KEY ("cardSha256") REFERENCES "skill_cards"("sha256") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_cards" ADD CONSTRAINT "skill_cards_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_card_grants" ADD CONSTRAINT "skill_card_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_card_grants" ADD CONSTRAINT "skill_card_grants_cardSha256_fkey" FOREIGN KEY ("cardSha256") REFERENCES "skill_cards"("sha256") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_cardSha256_fkey" FOREIGN KEY ("cardSha256") REFERENCES "skill_cards"("sha256") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_authorSkillId_fkey" FOREIGN KEY ("authorSkillId") REFERENCES "skills"("id") ON DELETE SET NULL ON UPDATE CASCADE;

