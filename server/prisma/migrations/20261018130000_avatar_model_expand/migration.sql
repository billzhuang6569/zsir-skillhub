BEGIN;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "avatarStyleId" TEXT;

-- AlterTable
ALTER TABLE "skill_avatars" ADD COLUMN     "currentJobId" TEXT;

-- AlterTable
ALTER TABLE "skill_avatar_generation_attempts" ADD COLUMN     "jobId" TEXT;

-- AlterTable
ALTER TABLE "marketplace_listings" ADD COLUMN     "avatarSnapshotAt" TIMESTAMP(3),
ADD COLUMN     "avatarSource" TEXT,
ADD COLUMN     "avatarStatus" TEXT,
ADD COLUMN     "avatarUpdatedById" TEXT,
ADD COLUMN     "avatarUrl" TEXT;

-- CreateTable
CREATE TABLE "avatar_generation_jobs" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "logicalSkillId" TEXT NOT NULL,
    "generationRevision" INTEGER NOT NULL,
    "selectionRevision" INTEGER NOT NULL,
    "styleId" TEXT NOT NULL,
    "styleVersion" INTEGER NOT NULL,
    "path" TEXT,
    "input" JSONB NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "prompt" TEXT,
    "promptSha256" CHAR(64),
    "falModel" TEXT NOT NULL,
    "falParameters" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "requestId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "imageUrl" TEXT,
    "imageData" BYTEA,
    "imageSha256" CHAR(64),
    "assetId" TEXT,
    "url" TEXT,
    "errorCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "avatar_generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "avatar_variants" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "logicalSkillId" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "styleVersion" INTEGER NOT NULL,
    "generationRevision" INTEGER NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "prompt" TEXT,
    "promptSha256" CHAR(64),
    "assetId" TEXT,
    "url" TEXT NOT NULL,
    "imageSha256" CHAR(64),
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "avatar_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "avatar_selections" (
    "ownerId" TEXT NOT NULL,
    "logicalSkillId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'generated',
    "variantId" TEXT,
    "currentJobId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "customAssetId" TEXT,
    "customUrl" TEXT,
    "customUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "avatar_selections_pkey" PRIMARY KEY ("ownerId","logicalSkillId")
);

-- CreateIndex
CREATE UNIQUE INDEX "avatar_generation_jobs_idempotencyKey_key" ON "avatar_generation_jobs"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "avatar_generation_jobs_requestId_key" ON "avatar_generation_jobs"("requestId");

-- CreateIndex
CREATE INDEX "avatar_generation_jobs_status_nextAttemptAt_leaseUntil_idx" ON "avatar_generation_jobs"("status", "nextAttemptAt", "leaseUntil");

-- CreateIndex
CREATE INDEX "avatar_generation_jobs_ownerId_leaseUntil_idx" ON "avatar_generation_jobs"("ownerId", "leaseUntil");

-- CreateIndex
CREATE INDEX "avatar_generation_jobs_queuedAt_idx" ON "avatar_generation_jobs"("queuedAt");

-- CreateIndex
CREATE INDEX "avatar_generation_jobs_ownerId_logicalSkillId_createdAt_idx" ON "avatar_generation_jobs"("ownerId", "logicalSkillId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "avatar_generation_jobs_id_ownerId_logicalSkillId_key" ON "avatar_generation_jobs"("id", "ownerId", "logicalSkillId");

-- CreateIndex
CREATE UNIQUE INDEX "avatar_generation_jobs_ownerId_logicalSkillId_generationRev_key" ON "avatar_generation_jobs"("ownerId", "logicalSkillId", "generationRevision");

-- CreateIndex
CREATE UNIQUE INDEX "avatar_variants_jobId_key" ON "avatar_variants"("jobId");

-- CreateIndex
CREATE INDEX "avatar_variants_reuse_idx" ON "avatar_variants"("ownerId", "logicalSkillId", "styleId", "styleVersion", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "avatar_variants_jobId_ownerId_logicalSkillId_key" ON "avatar_variants"("jobId", "ownerId", "logicalSkillId");

-- CreateIndex
CREATE UNIQUE INDEX "avatar_variants_id_ownerId_logicalSkillId_key" ON "avatar_variants"("id", "ownerId", "logicalSkillId");

-- CreateIndex
CREATE UNIQUE INDEX "avatar_variants_ownerId_logicalSkillId_generationRevision_key" ON "avatar_variants"("ownerId", "logicalSkillId", "generationRevision");

-- CreateIndex
CREATE INDEX "avatar_selections_variantId_idx" ON "avatar_selections"("variantId");

-- CreateIndex
CREATE INDEX "avatar_selections_currentJobId_idx" ON "avatar_selections"("currentJobId");

-- CreateIndex
CREATE UNIQUE INDEX "skill_avatars_currentJobId_key" ON "skill_avatars"("currentJobId");

-- CreateIndex
CREATE UNIQUE INDEX "skill_avatars_ownerId_id_key" ON "skill_avatars"("ownerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "skill_avatar_generation_attempts_jobId_key" ON "skill_avatar_generation_attempts"("jobId");

-- CreateIndex
CREATE INDEX "marketplace_listings_avatarUpdatedById_idx" ON "marketplace_listings"("avatarUpdatedById");

-- AddForeignKey
ALTER TABLE "avatar_generation_jobs" ADD CONSTRAINT "avatar_generation_jobs_ownerId_logicalSkillId_fkey" FOREIGN KEY ("ownerId", "logicalSkillId") REFERENCES "skill_avatars"("ownerId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "avatar_generation_jobs" ADD CONSTRAINT "avatar_generation_jobs_styleId_styleVersion_fkey" FOREIGN KEY ("styleId", "styleVersion") REFERENCES "avatar_style_versions"("styleId", "styleVersion") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "avatar_variants" ADD CONSTRAINT "avatar_variants_ownerId_logicalSkillId_fkey" FOREIGN KEY ("ownerId", "logicalSkillId") REFERENCES "skill_avatars"("ownerId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "avatar_variants" ADD CONSTRAINT "avatar_variants_styleId_styleVersion_fkey" FOREIGN KEY ("styleId", "styleVersion") REFERENCES "avatar_style_versions"("styleId", "styleVersion") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "avatar_variants" ADD CONSTRAINT "avatar_variants_jobId_ownerId_logicalSkillId_fkey" FOREIGN KEY ("jobId", "ownerId", "logicalSkillId") REFERENCES "avatar_generation_jobs"("id", "ownerId", "logicalSkillId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "avatar_selections" ADD CONSTRAINT "avatar_selections_ownerId_logicalSkillId_fkey" FOREIGN KEY ("ownerId", "logicalSkillId") REFERENCES "skill_avatars"("ownerId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "avatar_selections" ADD CONSTRAINT "avatar_selections_variantId_ownerId_logicalSkillId_fkey" FOREIGN KEY ("variantId", "ownerId", "logicalSkillId") REFERENCES "avatar_variants"("id", "ownerId", "logicalSkillId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "avatar_selections" ADD CONSTRAINT "avatar_selections_currentJobId_ownerId_logicalSkillId_fkey" FOREIGN KEY ("currentJobId", "ownerId", "logicalSkillId") REFERENCES "avatar_generation_jobs"("id", "ownerId", "logicalSkillId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "skill_avatars" ADD CONSTRAINT "skill_avatars_currentJobId_fkey" FOREIGN KEY ("currentJobId") REFERENCES "avatar_generation_jobs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "skill_avatar_generation_attempts" ADD CONSTRAINT "skill_avatar_generation_attempts_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "avatar_generation_jobs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_avatarUpdatedById_fkey" FOREIGN KEY ("avatarUpdatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "avatar_generation_jobs" ADD CONSTRAINT "avatar_jobs_values_check" CHECK (
  "generationRevision" > 0 AND "selectionRevision" > 0 AND attempts >= 0
  AND status IN ('queued','prompting','submitting','awaiting','transferring','ready','failed','needs_review','cancelled','superseded')
  AND (path IS NULL OR path IN ('meta','direct'))
  AND ("promptSha256" IS NULL OR "promptSha256" ~ '^[a-f0-9]{64}$')
  AND ("imageSha256" IS NULL OR "imageSha256" ~ '^[a-f0-9]{64}$'));
ALTER TABLE "avatar_variants" ADD CONSTRAINT "avatar_variants_values_check" CHECK (
  "generationRevision" > 0 AND path IN ('meta','direct')
  AND ("promptSha256" IS NULL OR "promptSha256" ~ '^[a-f0-9]{64}$')
  AND ("imageSha256" IS NULL OR "imageSha256" ~ '^[a-f0-9]{64}$'));
ALTER TABLE "avatar_selections" ADD CONSTRAINT "avatar_selection_values_check" CHECK (
  revision > 0 AND source IN ('generated','custom') AND (source <> 'custom' OR "customUrl" IS NOT NULL));
CREATE UNIQUE INDEX "avatar_jobs_one_active_per_anchor" ON "avatar_generation_jobs" ("ownerId", "logicalSkillId")
  WHERE status IN ('queued','prompting','submitting','awaiting','transferring','needs_review');

CREATE FUNCTION protect_avatar_variant() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'avatar_variant_immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER avatar_variant_immutable BEFORE UPDATE ON "avatar_variants"
  FOR EACH ROW EXECUTE FUNCTION protect_avatar_variant();

CREATE FUNCTION protect_avatar_submission() RETURNS trigger AS $$
BEGIN
  IF OLD."requestId" IS NOT NULL AND NEW."requestId" IS DISTINCT FROM OLD."requestId" THEN
    RAISE EXCEPTION 'avatar_request_immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."submittedAt" IS NOT NULL AND (
    NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt"
    OR ROW(NEW."styleId",NEW."styleVersion",NEW.path,NEW.input,NEW."inputFingerprint",NEW."promptVersion",NEW.prompt,NEW."promptSha256",NEW."falModel",NEW."falParameters",NEW."idempotencyKey")
       IS DISTINCT FROM ROW(OLD."styleId",OLD."styleVersion",OLD.path,OLD.input,OLD."inputFingerprint",OLD."promptVersion",OLD.prompt,OLD."promptSha256",OLD."falModel",OLD."falParameters",OLD."idempotencyKey")
    OR NEW.status IN ('queued','prompting')
  ) THEN
    RAISE EXCEPTION 'avatar_submission_immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."submittedAt" IS NOT NULL AND OLD."submittedAt" IS NULL
     AND (NEW.path IS NULL OR NEW.prompt IS NULL OR NEW."promptSha256" IS NULL) THEN
    RAISE EXCEPTION 'avatar_submission_incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER avatar_submission_immutable BEFORE UPDATE ON "avatar_generation_jobs"
  FOR EACH ROW EXECUTE FUNCTION protect_avatar_submission();

COMMIT;
