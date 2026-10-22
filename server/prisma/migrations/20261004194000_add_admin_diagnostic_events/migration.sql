CREATE TABLE "admin_diagnostic_events" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "eventCode" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    CONSTRAINT "admin_diagnostic_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_diagnostic_events_createdAt_id_idx" ON "admin_diagnostic_events"("createdAt", "id");
CREATE INDEX "admin_diagnostic_events_requestId_createdAt_idx" ON "admin_diagnostic_events"("requestId", "createdAt");
CREATE INDEX "admin_diagnostic_events_fingerprint_createdAt_idx" ON "admin_diagnostic_events"("fingerprint", "createdAt");
