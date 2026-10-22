-- Existing intents predate device-bound proof and must never become consumable
-- after this migration. A fixed syntactically valid challenge is safe only
-- because every pending intent is invalidated before the column becomes NOT NULL.
ALTER TABLE "credential_fetch_intents"
  -- Keep a valid fixed default so the pre-migration server remains able to
  -- insert intents if deployment rolls back after this additive migration.
  -- The new server always writes a fresh random challenge explicitly.
  ADD COLUMN "challenge" TEXT DEFAULT 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ADD COLUMN "proofVersion" INTEGER NOT NULL DEFAULT 1;

UPDATE "credential_fetch_intents"
SET
  "challenge" = repeat('A', 43),
  "status" = CASE WHEN "status" = 'pending' THEN 'invalidated' ELSE "status" END,
  "invalidatedAt" = CASE
    WHEN "status" = 'pending' THEN COALESCE("invalidatedAt", CURRENT_TIMESTAMP)
    ELSE "invalidatedAt"
  END;

ALTER TABLE "credential_fetch_intents"
  ALTER COLUMN "challenge" SET NOT NULL,
  ADD CONSTRAINT "credential_fetch_intents_challenge_check"
    CHECK ("challenge" ~ '^[A-Za-z0-9_-]{43}$'),
  ADD CONSTRAINT "credential_fetch_intents_proof_version_check"
    CHECK ("proofVersion" > 0);

CREATE TABLE "credential_devices" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "secretCiphertext" BYTEA NOT NULL,
  "secretIv" BYTEA NOT NULL,
  "secretTag" BYTEA NOT NULL,
  "wrappedDek" BYTEA NOT NULL,
  "wrapIv" BYTEA NOT NULL,
  "wrapTag" BYTEA NOT NULL,
  "kekVersion" INTEGER NOT NULL,
  "aadVersion" INTEGER NOT NULL DEFAULT 1,
  "registrationTokenVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),

  CONSTRAINT "credential_devices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credential_devices_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
  CONSTRAINT "credential_devices_key_version_check"
    CHECK ("kekVersion" > 0 AND "aadVersion" > 0 AND "registrationTokenVersion" >= 0),
  CONSTRAINT "credential_devices_envelope_shape_check" CHECK (
    octet_length("secretCiphertext") = 32
    AND octet_length("secretIv") = 12
    AND octet_length("secretTag") = 16
    AND octet_length("wrappedDek") = 32
    AND octet_length("wrapIv") = 12
    AND octet_length("wrapTag") = 16
  )
);

CREATE INDEX "credential_devices_userId_revokedAt_idx"
  ON "credential_devices"("userId", "revokedAt");

ALTER TABLE "credential_devices"
  ADD CONSTRAINT "credential_devices_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
