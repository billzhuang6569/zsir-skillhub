ALTER TABLE "marketplace_listings"
ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "editorialLabels" JSONB NOT NULL DEFAULT '[]';
