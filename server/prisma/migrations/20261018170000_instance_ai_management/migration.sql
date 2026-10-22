-- Existing skills predate self-hosting and are treated as already analysed.
ALTER TABLE "skills" ADD COLUMN "analysisStatus" TEXT NOT NULL DEFAULT 'completed',
  -- Protect existing labels from being overwritten by batch reanalysis.
  ADD COLUMN "labelsManuallyEdited" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "skills" ALTER COLUMN "analysisStatus" SET DEFAULT 'unanalysed';

CREATE TABLE "ai_daily_usage" (
  "day" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0 CHECK ("count" >= 0),
  PRIMARY KEY ("day", "userId")
);
