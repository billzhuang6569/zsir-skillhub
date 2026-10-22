ALTER TABLE "skill_versions"
ADD COLUMN "packageData" BYTEA,
ADD COLUMN "packageSha256" TEXT,
ADD COLUMN "packageSize" INTEGER;
