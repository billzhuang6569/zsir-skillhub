-- Skill avatar daily quota as a generation-attempt ledger (#221).
-- One row per new paid generation attempt; usage for a UTC day = rows of that day not released.
-- skill_avatars."queuedAt" stays as "last queued" for display and ordering and no longer drives the quota.
CREATE TABLE "skill_avatar_generation_attempts" (
    "id" TEXT NOT NULL,
    "avatarId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    CONSTRAINT "skill_avatar_generation_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "skill_avatar_generation_attempts_kind_check" CHECK ("kind" IN ('create', 'restore', 'retry', 'baseline'))
);

ALTER TABLE "skill_avatar_generation_attempts" ADD CONSTRAINT "skill_avatar_generation_attempts_avatarId_fkey"
  FOREIGN KEY ("avatarId") REFERENCES "skill_avatars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "skill_avatar_generation_attempts_avatarId_createdAt_idx" ON "skill_avatar_generation_attempts"("avatarId", "createdAt");
-- Partial indexes (not expressible in schema.prisma): the daily count, and at most one baseline per task.
CREATE INDEX "skill_avatar_generation_attempts_open_day_idx" ON "skill_avatar_generation_attempts"("day") WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "skill_avatar_generation_attempts_baseline_key" ON "skill_avatar_generation_attempts"("avatarId") WHERE "kind" = 'baseline';

-- Backfill only what existing columns prove: each task's most recent queueing, on the UTC day of
-- "queuedAt" (Prisma stores naive UTC timestamps, so a plain ::date is the UTC day whatever the
-- session time zone). #219 only cancels unclaimed queued tasks, so a cancelled row was never paid
-- and is refunded at its "updatedAt". Upload-only rows ("queuedAt" IS NULL) never queued and get
-- nothing. Re-running is a no-op: the id is derived from the task and the baseline index is unique.
INSERT INTO "skill_avatar_generation_attempts" ("id", "avatarId", "day", "kind", "createdAt", "releasedAt")
SELECT md5(a."id" || ':baseline')::uuid::text, a."id", a."queuedAt"::date, 'baseline', a."queuedAt",
       CASE WHEN a."status" = 'cancelled' THEN a."updatedAt" END
FROM "skill_avatars" a
WHERE a."queuedAt" IS NOT NULL
ON CONFLICT ("avatarId") WHERE "kind" = 'baseline' DO NOTHING;
