-- Store-admin "原创" (original) mark on a public listing (#193). Additive; existing listings stay unmarked.
ALTER TABLE "marketplace_listings" ADD COLUMN "original" BOOLEAN NOT NULL DEFAULT false;
