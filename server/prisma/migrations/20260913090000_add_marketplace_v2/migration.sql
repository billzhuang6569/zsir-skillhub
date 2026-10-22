-- Marketplace discovery, discussion, install attribution, and managed-user metrics.
ALTER TABLE "marketplace_listings"
  ADD COLUMN "categoryId" TEXT,
  ADD COLUMN "installClickCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "activeUserCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "marketplace_categories" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "marketplace_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "marketplace_topics" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "coverImageUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "featured" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "marketplace_topics_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "marketplace_topic_items" (
  "topicId" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "marketplace_topic_items_pkey" PRIMARY KEY ("topicId", "skillId")
);

CREATE TABLE "marketplace_comments" (
  "id" TEXT NOT NULL,
  "listingSkillId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "visibility" TEXT NOT NULL DEFAULT 'public',
  "teamId" TEXT,
  "parentId" TEXT,
  "content" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'visible',
  "moderatorId" TEXT,
  "moderationNote" TEXT,
  "moderatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "marketplace_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "marketplace_install_intents" (
  "id" TEXT NOT NULL,
  "listingSkillId" TEXT NOT NULL,
  "userId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "clientIdHash" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'app',
  "platform" TEXT,
  "status" TEXT NOT NULL DEFAULT 'clicked',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "marketplace_install_intents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "marketplace_managed_presences" (
  "listingSkillId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "marketplace_managed_presences_pkey" PRIMARY KEY ("listingSkillId", "userId", "deviceId")
);

CREATE UNIQUE INDEX "marketplace_categories_slug_key" ON "marketplace_categories"("slug");
CREATE UNIQUE INDEX "marketplace_categories_name_key" ON "marketplace_categories"("name");
CREATE INDEX "marketplace_categories_enabled_sortOrder_name_idx" ON "marketplace_categories"("enabled", "sortOrder", "name");
CREATE UNIQUE INDEX "marketplace_topics_slug_key" ON "marketplace_topics"("slug");
CREATE INDEX "marketplace_topics_status_featured_sortOrder_publishedAt_idx" ON "marketplace_topics"("status", "featured", "sortOrder", "publishedAt");
CREATE INDEX "marketplace_topic_items_topicId_sortOrder_idx" ON "marketplace_topic_items"("topicId", "sortOrder");
CREATE INDEX "marketplace_comments_listingSkillId_visibility_teamId_status_parent_idx" ON "marketplace_comments"("listingSkillId", "visibility", "teamId", "status", "parentId", "createdAt");
CREATE INDEX "marketplace_comments_userId_createdAt_idx" ON "marketplace_comments"("userId", "createdAt");
CREATE UNIQUE INDEX "marketplace_install_intents_idempotencyKey_key" ON "marketplace_install_intents"("idempotencyKey");
CREATE INDEX "marketplace_install_intents_listingSkillId_createdAt_idx" ON "marketplace_install_intents"("listingSkillId", "createdAt");
CREATE INDEX "marketplace_install_intents_userId_createdAt_idx" ON "marketplace_install_intents"("userId", "createdAt");
CREATE INDEX "marketplace_managed_presences_listingSkillId_active_lastSeenAt_idx" ON "marketplace_managed_presences"("listingSkillId", "active", "lastSeenAt");
CREATE INDEX "marketplace_managed_presences_userId_deviceId_active_idx" ON "marketplace_managed_presences"("userId", "deviceId", "active");
CREATE INDEX "marketplace_listings_withdrawnAt_installClickCount_idx" ON "marketplace_listings"("withdrawnAt", "installClickCount");
CREATE INDEX "marketplace_listings_withdrawnAt_activeUserCount_idx" ON "marketplace_listings"("withdrawnAt", "activeUserCount");
CREATE INDEX "marketplace_listings_categoryId_withdrawnAt_publishedAt_idx" ON "marketplace_listings"("categoryId", "withdrawnAt", "publishedAt");

ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "marketplace_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketplace_topic_items" ADD CONSTRAINT "marketplace_topic_items_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "marketplace_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketplace_topic_items" ADD CONSTRAINT "marketplace_topic_items_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "marketplace_listings"("skillId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketplace_comments" ADD CONSTRAINT "marketplace_comments_listingSkillId_fkey" FOREIGN KEY ("listingSkillId") REFERENCES "marketplace_listings"("skillId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketplace_comments" ADD CONSTRAINT "marketplace_comments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketplace_comments" ADD CONSTRAINT "marketplace_comments_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketplace_comments" ADD CONSTRAINT "marketplace_comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "marketplace_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketplace_install_intents" ADD CONSTRAINT "marketplace_install_intents_listingSkillId_fkey" FOREIGN KEY ("listingSkillId") REFERENCES "marketplace_listings"("skillId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketplace_install_intents" ADD CONSTRAINT "marketplace_install_intents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketplace_managed_presences" ADD CONSTRAINT "marketplace_managed_presences_listingSkillId_fkey" FOREIGN KEY ("listingSkillId") REFERENCES "marketplace_listings"("skillId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketplace_managed_presences" ADD CONSTRAINT "marketplace_managed_presences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve the existing free-text category until an administrator maps it to
-- a managed directory. This avoids inventing or merging categories during migration.
