CREATE TABLE "admin_agent_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "issuerAdminId" TEXT,
    "clientOperationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    CONSTRAINT "admin_agent_keys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admin_agent_audit_events" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "actorAdminId" TEXT,
    "operationId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_agent_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_agent_keys_secretHash_key" ON "admin_agent_keys"("secretHash");
CREATE UNIQUE INDEX "admin_agent_keys_issuerAdminId_clientOperationId_key" ON "admin_agent_keys"("issuerAdminId", "clientOperationId");
CREATE INDEX "admin_agent_keys_issuerAdminId_createdAt_idx" ON "admin_agent_keys"("issuerAdminId", "createdAt");
CREATE INDEX "admin_agent_audit_events_keyId_createdAt_idx" ON "admin_agent_audit_events"("keyId", "createdAt");
CREATE INDEX "admin_agent_audit_events_createdAt_id_idx" ON "admin_agent_audit_events"("createdAt", "id");

ALTER TABLE "admin_agent_keys" ADD CONSTRAINT "admin_agent_keys_issuerAdminId_fkey" FOREIGN KEY ("issuerAdminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "admin_agent_audit_events" ADD CONSTRAINT "admin_agent_audit_events_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "admin_agent_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin_agent_audit_events" ADD CONSTRAINT "admin_agent_audit_events_actorAdminId_fkey" FOREIGN KEY ("actorAdminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
