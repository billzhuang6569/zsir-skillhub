-- Admin unlisting (#208): who withdrew a listing and why.
ALTER TABLE "marketplace_listings" ADD COLUMN "withdrawnBy" TEXT;
ALTER TABLE "marketplace_listings" ADD COLUMN "withdrawnReason" TEXT;
-- Before this migration only authors could withdraw a listing.
UPDATE "marketplace_listings" SET "withdrawnBy" = 'author' WHERE "withdrawnAt" IS NOT NULL AND "withdrawnBy" IS NULL;

-- Web admin sessions audit their writes in the same table without an Agent Key.
ALTER TABLE "admin_agent_audit_events" ALTER COLUMN "keyId" DROP NOT NULL;
ALTER TABLE "admin_agent_audit_events" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'agent';
