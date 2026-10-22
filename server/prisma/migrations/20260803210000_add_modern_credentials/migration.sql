-- Modern team credential protocol. Secret values are stored only as
-- envelope-encrypted, immutable revisions. One-time fetch intents and audit
-- events are deliberately separate from the legacy skill_env_shares table.

CREATE TABLE "credential_bindings" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "envKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currentRevision" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "credential_bindings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credential_bindings_status_check" CHECK ("status" IN ('active', 'revoked')),
    CONSTRAINT "credential_bindings_revision_check" CHECK ("currentRevision" >= 0),
    CONSTRAINT "credential_bindings_env_key_check" CHECK ("envKey" ~ '^[A-Z][A-Z0-9_]{0,99}$')
);

CREATE TABLE "credential_versions" (
    "id" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "wrapIv" BYTEA NOT NULL,
    "wrapTag" BYTEA NOT NULL,
    "kekVersion" INTEGER NOT NULL,
    "aadVersion" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credential_versions_revision_check" CHECK ("revision" > 0),
    CONSTRAINT "credential_versions_key_version_check" CHECK ("kekVersion" > 0 AND "aadVersion" > 0),
    CONSTRAINT "credential_versions_payload_check" CHECK (
      octet_length("ciphertext") > 0
      AND octet_length("iv") = 12
      AND octet_length("tag") = 16
      AND octet_length("wrappedDek") = 32
      AND octet_length("wrapIv") = 12
      AND octet_length("wrapTag") = 16
    )
);

CREATE TABLE "credential_fetch_intents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "requestedKeys" JSONB NOT NULL,
    "bindingRevisionDigest" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "sessionFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_fetch_intents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credential_fetch_intents_purpose_check" CHECK ("purpose" IN ('run', 'validate')),
    CONSTRAINT "credential_fetch_intents_status_check" CHECK ("status" IN ('pending', 'consumed', 'expired', 'invalidated')),
    CONSTRAINT "credential_fetch_intents_digest_check" CHECK (
      "bindingRevisionDigest" ~ '^[a-f0-9]{64}$'
      AND "nonceHash" ~ '^[a-f0-9]{64}$'
      AND "sessionFingerprint" ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT "credential_fetch_intents_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE TABLE "credential_audit_events" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "actorId" TEXT,
    "skillId" TEXT,
    "teamId" TEXT,
    "intentId" TEXT,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reasonCode" TEXT,
    "bindingIds" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_audit_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "credential_audit_events_outcome_check" CHECK ("outcome" IN ('success', 'denied', 'error'))
);

CREATE UNIQUE INDEX "credential_bindings_skillId_teamId_envKey_key"
  ON "credential_bindings"("skillId", "teamId", "envKey");
CREATE INDEX "credential_bindings_teamId_status_idx"
  ON "credential_bindings"("teamId", "status");
CREATE INDEX "credential_bindings_skillId_teamId_status_idx"
  ON "credential_bindings"("skillId", "teamId", "status");

CREATE UNIQUE INDEX "credential_versions_bindingId_revision_key"
  ON "credential_versions"("bindingId", "revision");
CREATE INDEX "credential_versions_createdAt_idx"
  ON "credential_versions"("createdAt");

CREATE INDEX "credential_fetch_intents_userId_createdAt_idx"
  ON "credential_fetch_intents"("userId", "createdAt");
CREATE INDEX "credential_fetch_intents_userId_status_expiresAt_idx"
  ON "credential_fetch_intents"("userId", "status", "expiresAt");
CREATE INDEX "credential_fetch_intents_skillId_teamId_status_idx"
  ON "credential_fetch_intents"("skillId", "teamId", "status");

CREATE INDEX "credential_audit_events_actorId_createdAt_idx"
  ON "credential_audit_events"("actorId", "createdAt");
CREATE INDEX "credential_audit_events_skillId_teamId_createdAt_idx"
  ON "credential_audit_events"("skillId", "teamId", "createdAt");
CREATE INDEX "credential_audit_events_intentId_idx"
  ON "credential_audit_events"("intentId");

ALTER TABLE "credential_bindings"
  ADD CONSTRAINT "credential_bindings_skillId_fkey"
  FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credential_bindings"
  ADD CONSTRAINT "credential_bindings_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credential_bindings"
  ADD CONSTRAINT "credential_bindings_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "credential_versions"
  ADD CONSTRAINT "credential_versions_bindingId_fkey"
  FOREIGN KEY ("bindingId") REFERENCES "credential_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credential_versions"
  ADD CONSTRAINT "credential_versions_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "credential_fetch_intents"
  ADD CONSTRAINT "credential_fetch_intents_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credential_fetch_intents"
  ADD CONSTRAINT "credential_fetch_intents_skillId_fkey"
  FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credential_fetch_intents"
  ADD CONSTRAINT "credential_fetch_intents_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "credential_audit_events"
  ADD CONSTRAINT "credential_audit_events_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "credential_audit_events"
  ADD CONSTRAINT "credential_audit_events_skillId_fkey"
  FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "credential_audit_events"
  ADD CONSTRAINT "credential_audit_events_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "credential_audit_events"
  ADD CONSTRAINT "credential_audit_events_intentId_fkey"
  FOREIGN KEY ("intentId") REFERENCES "credential_fetch_intents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
