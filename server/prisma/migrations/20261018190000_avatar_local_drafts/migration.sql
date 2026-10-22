BEGIN;

ALTER TABLE "avatar_generation_jobs"
  ADD COLUMN "draftDeadline" TIMESTAMP(3),
  ADD COLUMN "promptSource" TEXT CHECK ("promptSource" IN ('instance','local','direct'));

ALTER TABLE "avatar_generation_jobs" DROP CONSTRAINT "avatar_jobs_values_check";
ALTER TABLE "avatar_generation_jobs" ADD CONSTRAINT "avatar_jobs_values_check" CHECK (
  "generationRevision" > 0 AND "selectionRevision" > 0 AND attempts >= 0
  AND status IN ('queued','drafting','prompting','submitting','awaiting','transferring','ready','failed','needs_review','cancelled','superseded')
  AND (path IS NULL OR path IN ('meta','direct'))
  AND ("promptSha256" IS NULL OR "promptSha256" ~ '^[a-f0-9]{64}$')
  AND ("imageSha256" IS NULL OR "imageSha256" ~ '^[a-f0-9]{64}$')
  AND (status <> 'drafting' OR (prompt IS NULL AND "submittedAt" IS NULL AND "requestId" IS NULL)));

DROP INDEX "avatar_jobs_one_active_per_anchor";
CREATE UNIQUE INDEX "avatar_jobs_one_active_per_anchor" ON "avatar_generation_jobs" ("ownerId", "logicalSkillId")
  WHERE status IN ('queued','drafting','prompting','submitting','awaiting','transferring','needs_review');

-- The compatibility mirror must accept the new pending state too.
ALTER TABLE "skill_avatars" DROP CONSTRAINT "skill_avatars_status_check";
ALTER TABLE "skill_avatars" ADD CONSTRAINT "skill_avatars_status_check"
  CHECK (status IN ('queued','drafting','prompting','submitting','awaiting','transferring','ready','failed','needs_review','cancelled','superseded'));

ALTER TABLE "local_ai_leases"
  ALTER COLUMN "skillId" DROP NOT NULL,
  ADD COLUMN "avatarJobId" TEXT REFERENCES "avatar_generation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "local_ai_leases_target_check" CHECK (
    (type = 'analyzeSkill' AND "skillId" IS NOT NULL AND "avatarJobId" IS NULL)
    OR (type = 'draftAvatarPrompt' AND "avatarJobId" IS NOT NULL));
CREATE UNIQUE INDEX "local_ai_leases_avatarJobId_type_key" ON "local_ai_leases" ("avatarJobId", type);

COMMIT;
