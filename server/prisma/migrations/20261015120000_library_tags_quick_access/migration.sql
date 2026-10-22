-- #322: private per-user Skill tags and sidebar quick access.
CREATE TABLE "library_skill_tags" (
    "userId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_skill_tags_pkey" PRIMARY KEY ("userId","entryId","nameKey")
);

CREATE TABLE "library_quick_access" (
    "userId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "items" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "library_quick_access_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "library_skill_tags_userId_nameKey_idx" ON "library_skill_tags"("userId", "nameKey");
CREATE INDEX "library_skill_tags_entryId_idx" ON "library_skill_tags"("entryId");

ALTER TABLE "library_skill_tags" ADD CONSTRAINT "library_skill_tags_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "library_skill_tags" ADD CONSTRAINT "library_skill_tags_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "library_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "library_quick_access" ADD CONSTRAINT "library_quick_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
