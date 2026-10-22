ALTER TABLE "feedback"
ADD COLUMN "diagnostics" JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN "clientOperationId" TEXT,
ADD COLUMN "operationScopeHash" TEXT,
ADD COLUMN "requestDigest" TEXT;

CREATE UNIQUE INDEX "feedback_operationScopeHash_clientOperationId_key"
ON "feedback"("operationScopeHash", "clientOperationId");

ALTER TABLE "feedback"
ADD CONSTRAINT "feedback_operation_fields_consistent"
CHECK (
  (
    "clientOperationId" IS NULL
    AND "operationScopeHash" IS NULL
    AND "requestDigest" IS NULL
  )
  OR
  (
    "clientOperationId" IS NOT NULL
    AND "operationScopeHash" IS NOT NULL
    AND "requestDigest" IS NOT NULL
  )
);
