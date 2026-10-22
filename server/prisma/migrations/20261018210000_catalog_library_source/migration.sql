ALTER TABLE "library_entries" ADD COLUMN "sourceOrigin" TEXT;

-- Upload possession and catalog provenance must survive each other's writes.
ALTER TABLE "skill_card_grants" ADD COLUMN "uploadedAt" TIMESTAMP(3), ADD COLUMN "priorSourceRef" TEXT;
UPDATE "skill_card_grants" SET "uploadedAt" = "createdAt" WHERE "reason" = 'upload';

-- Official IDs live in a different namespace from this instance's Skills.
ALTER TABLE "library_entries" ADD CONSTRAINT "library_entries_catalog_source_check"
  CHECK ("sourceKind" <> 'catalog' OR
    ("sourceOrigin" IS NOT NULL AND "sourceSkillId" IS NOT NULL
      AND "sourceVersionId" IS NOT NULL AND "authorSkillId" IS NULL));

CREATE UNIQUE INDEX "library_entries_catalog_active_key"
  ON "library_entries" ("userId", "sourceOrigin", "sourceSkillId")
  WHERE "sourceKind" = 'catalog' AND "deletedAt" IS NULL;
