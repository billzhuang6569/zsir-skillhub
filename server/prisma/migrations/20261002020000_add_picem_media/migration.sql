CREATE TABLE "media_assets" (
  "id" TEXT NOT NULL,
  "assetId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'uploading',
  "uploadedById" TEXT,
  "ownerRef" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "visibility" TEXT NOT NULL,
  "url" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_assets_url_key" ON "media_assets"("url");
CREATE UNIQUE INDEX "media_assets_assetId_key" ON "media_assets"("assetId");
CREATE INDEX "media_assets_ownerRef_idx" ON "media_assets"("ownerRef");
