CREATE TABLE "app_release_download_metrics" (
    "day" DATE NOT NULL,
    "version" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_release_download_metrics_pkey" PRIMARY KEY ("day", "version", "target", "arch")
);

CREATE INDEX "app_release_download_metrics_version_day_idx"
ON "app_release_download_metrics"("version", "day");
