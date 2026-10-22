ALTER TABLE "library_entries" ADD COLUMN "currentVersionReceiptId" TEXT,
ADD COLUMN "versionHighWater" INTEGER NOT NULL DEFAULT -1;
ALTER TABLE "skills" ADD COLUMN "importVersionId" TEXT,
ADD COLUMN "versionHighWater" INTEGER NOT NULL DEFAULT -1,
ALTER COLUMN "currentVersion" SET DEFAULT '0.1.0';
CREATE TABLE "library_entry_versions" (
  "id" TEXT PRIMARY KEY, "entryId" TEXT NOT NULL, "label" TEXT NOT NULL,
  "cardSha256" TEXT NOT NULL, "formalVersionId" TEXT, "requestDigest" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "skill_version_label_aliases" (
  "skillId" TEXT NOT NULL, "versionId" TEXT NOT NULL, "oldLabel" TEXT NOT NULL,
  "newLabel" TEXT NOT NULL, "planDigest" TEXT NOT NULL,
  PRIMARY KEY ("skillId", "oldLabel")
);
CREATE INDEX "library_entry_versions_cardSha256_idx" ON "library_entry_versions"("cardSha256");
CREATE UNIQUE INDEX "library_entry_versions_entryId_label_key" ON "library_entry_versions"("entryId", "label");
CREATE UNIQUE INDEX "library_entry_versions_id_entryId_key" ON "library_entry_versions"("id", "entryId");
CREATE UNIQUE INDEX "library_entry_versions_entryId_formalVersionId_key" ON "library_entry_versions"("entryId", "formalVersionId");
CREATE INDEX "skill_version_label_aliases_versionId_idx" ON "skill_version_label_aliases"("versionId");
CREATE UNIQUE INDEX "skill_versions_id_skillId_key" ON "skill_versions"("id", "skillId");
ALTER TABLE "skills" ADD CONSTRAINT "skills_importVersionId_id_fkey" FOREIGN KEY ("importVersionId", "id") REFERENCES "skill_versions"("id", "skillId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_currentVersionReceiptId_id_fkey" FOREIGN KEY ("currentVersionReceiptId", "id") REFERENCES "library_entry_versions"("id", "entryId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "library_entry_versions" ADD CONSTRAINT "library_entry_versions_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "library_entries"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "library_entry_versions" ADD CONSTRAINT "library_entry_versions_cardSha256_fkey" FOREIGN KEY ("cardSha256") REFERENCES "skill_cards"("sha256") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "library_entry_versions" ADD CONSTRAINT "library_entry_versions_formalVersionId_fkey" FOREIGN KEY ("formalVersionId") REFERENCES "skill_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "skill_version_label_aliases" ADD CONSTRAINT "skill_version_label_aliases_versionId_skillId_fkey" FOREIGN KEY ("versionId", "skillId") REFERENCES "skill_versions"("id", "skillId") ON DELETE NO ACTION ON UPDATE NO ACTION;
