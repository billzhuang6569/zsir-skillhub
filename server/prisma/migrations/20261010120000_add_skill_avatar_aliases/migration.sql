-- CreateTable
CREATE TABLE "skill_avatar_aliases" (
    "ownerId" TEXT NOT NULL,
    "aliasLocalId" TEXT NOT NULL,
    "avatarId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_avatar_aliases_pkey" PRIMARY KEY ("ownerId","aliasLocalId")
);

-- CreateIndex
CREATE INDEX "skill_avatar_aliases_avatarId_idx" ON "skill_avatar_aliases"("avatarId");

-- AddForeignKey
ALTER TABLE "skill_avatar_aliases" ADD CONSTRAINT "skill_avatar_aliases_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_avatar_aliases" ADD CONSTRAINT "skill_avatar_aliases_avatarId_fkey" FOREIGN KEY ("avatarId") REFERENCES "skill_avatars"("id") ON DELETE CASCADE ON UPDATE CASCADE;
