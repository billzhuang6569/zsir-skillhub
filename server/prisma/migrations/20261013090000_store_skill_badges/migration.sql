-- Store Skill badges (#197): first publication time and per-day listing counters.

-- First time a listing went public. Approving a new version or re-listing never changes it.
ALTER TABLE "marketplace_listings" ADD COLUMN "firstPublishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill from the earliest approval of any reviewed, non-rejected submission, never later than the current publication.
UPDATE "marketplace_listings" AS l
SET "firstPublishedAt" = LEAST(
  l."publishedAt",
  COALESCE(
    (SELECT MIN(s."reviewedAt") FROM "marketplace_submissions" AS s
     WHERE s."skillId" = l."skillId" AND s."reviewedAt" IS NOT NULL AND s."status" IN ('approved', 'withdrawn')),
    l."publishedAt"
  )
);

CREATE INDEX "marketplace_listings_withdrawnAt_firstPublishedAt_idx" ON "marketplace_listings"("withdrawnAt", "firstPublishedAt");

-- Per listing, per store calendar day (Asia/Shanghai). No user or client identifiers.
CREATE TABLE "marketplace_listing_daily_metrics" (
    "listingSkillId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "installs" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "marketplace_listing_daily_metrics_pkey" PRIMARY KEY ("listingSkillId","day")
);

CREATE INDEX "marketplace_listing_daily_metrics_day_idx" ON "marketplace_listing_daily_metrics"("day");

ALTER TABLE "marketplace_listing_daily_metrics" ADD CONSTRAINT "marketplace_listing_daily_metrics_listingSkillId_fkey" FOREIGN KEY ("listingSkillId") REFERENCES "marketplace_listings"("skillId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Installs have a full history in install intents (each created intent incremented installClickCount once).
-- ZIP downloads were only ever a running total, so their daily history starts at deployment.
INSERT INTO "marketplace_listing_daily_metrics" ("listingSkillId", "day", "installs")
SELECT i."listingSkillId",
       ((i."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai')::date,
       COUNT(*)::int
FROM "marketplace_install_intents" AS i
JOIN "marketplace_listings" AS l ON l."skillId" = i."listingSkillId"
GROUP BY 1, 2;
