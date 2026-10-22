CREATE TABLE "server_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "secretCiphertext" BYTEA,
    "secretIv" BYTEA,
    "secretTag" BYTEA,
    "secretWrappedDek" BYTEA,
    "secretWrapIv" BYTEA,
    "secretWrapTag" BYTEA,
    "secretKekVersion" INTEGER,
    "secretAadVersion" INTEGER,
    "secretLast4" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    CONSTRAINT "server_settings_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "server_settings" ADD CONSTRAINT "server_settings_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
