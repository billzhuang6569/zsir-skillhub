BEGIN;
ALTER TABLE "skills" ADD COLUMN "migrationSource" JSONB, ADD COLUMN "storeCopy" JSONB;
CREATE TABLE "skill_migrations" (
  "id" TEXT PRIMARY KEY,
  "targetUserId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sourceProfile" TEXT NOT NULL,
  "sourceOrigin" TEXT NOT NULL,
  "sourceUserId" TEXT NOT NULL,
  "protocolVersion" INTEGER NOT NULL CHECK ("protocolVersion" = 1),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "skill_migrations_targetUserId_createdAt_idx" ON "skill_migrations"("targetUserId", "createdAt");
CREATE TABLE "skill_migration_items" (
  "id" TEXT PRIMARY KEY,
  "migrationId" TEXT NOT NULL REFERENCES "skill_migrations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "operationKey" TEXT NOT NULL,
  "payloadHash" CHAR(64) NOT NULL,
  "result" JSONB NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "skill_migration_items_migrationId_operationKey_key" ON "skill_migration_items"("migrationId", "operationKey");
CREATE TABLE "skill_migration_avatars" (
  "id" TEXT PRIMARY KEY,
  "migrationId" TEXT NOT NULL REFERENCES "skill_migrations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "operationKey" TEXT NOT NULL,
  "avatarId" TEXT NOT NULL,
  "payloadHash" CHAR(64) NOT NULL,
  "assetId" TEXT,
  "url" TEXT,
  "code" TEXT
);
CREATE UNIQUE INDEX "skill_migration_avatars_migrationId_operationKey_avatarId_key" ON "skill_migration_avatars"("migrationId", "operationKey", "avatarId");
COMMIT;
