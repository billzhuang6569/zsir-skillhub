BEGIN;
-- A submitted old style must finish into history while a different style can queue.
-- Keep same-style deduplication across versions, including unknown submissions.
DROP INDEX "avatar_jobs_one_active_per_anchor";
CREATE UNIQUE INDEX "avatar_jobs_one_active_per_style" ON "avatar_generation_jobs" ("ownerId", "logicalSkillId", "styleId")
  WHERE status IN ('queued','drafting','prompting','submitting','awaiting','transferring','needs_review');
COMMIT;
