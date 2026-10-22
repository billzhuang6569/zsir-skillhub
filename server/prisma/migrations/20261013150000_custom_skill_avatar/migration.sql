-- Custom Skill avatars (#214): the displayed source is kept apart from the generation task.
-- A user upload only writes the four display columns; generation fields keep their own state.
ALTER TABLE "skill_avatars"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'generated',
  ADD COLUMN "customAssetId" TEXT,
  ADD COLUMN "customUrl" TEXT,
  ADD COLUMN "customUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "queuedAt" TIMESTAMP(3);

-- Every existing task entered the paid queue when it was created.
UPDATE "skill_avatars" SET "queuedAt" = "createdAt";

ALTER TABLE "skill_avatars" ADD CONSTRAINT "skill_avatars_source_check"
  CHECK ("source" IN ('generated', 'custom'));
ALTER TABLE "skill_avatars" ADD CONSTRAINT "skill_avatars_custom_check"
  CHECK ("source" <> 'custom' OR ("customAssetId" IS NOT NULL AND "customUrl" IS NOT NULL));

-- `cancelled`: an unpaid queued task the user replaced with an upload. Not active; the worker never leases it.
ALTER TABLE "skill_avatars" DROP CONSTRAINT "skill_avatars_status_check";
ALTER TABLE "skill_avatars" ADD CONSTRAINT "skill_avatars_status_check"
  CHECK ("status" IN ('queued', 'prompting', 'submitting', 'awaiting', 'transferring', 'ready', 'failed', 'needs_review', 'cancelled'));

-- The daily generation quota counts tasks by the time they entered the queue.
CREATE INDEX "skill_avatars_queuedAt_idx" ON "skill_avatars"("queuedAt");
