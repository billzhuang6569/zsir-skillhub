-- Existing demo/OAuth users remain valid without password credentials.
-- Email/password registrations always populate both fields at the application layer.
ALTER TABLE "users"
ADD COLUMN "passwordHash" TEXT,
ADD COLUMN "passwordSalt" TEXT,
ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
