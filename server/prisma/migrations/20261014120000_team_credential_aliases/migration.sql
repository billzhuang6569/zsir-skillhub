-- Team key aliases (#288): other variable names that resolve to the same team
-- key value. Within one team a name belongs to at most one key; the unique
-- (teamId, envKey) index enforces it across aliases, and the routes also
-- refuse an alias equal to another active key's main name. Additive only.

-- CreateTable
CREATE TABLE "team_credential_aliases" (
    "credentialId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "envKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_credential_aliases_pkey" PRIMARY KEY ("credentialId","envKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "team_credential_aliases_teamId_envKey_key" ON "team_credential_aliases"("teamId", "envKey");

-- AddForeignKey
ALTER TABLE "team_credential_aliases" ADD CONSTRAINT "team_credential_aliases_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "team_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_credential_aliases" ADD CONSTRAINT "team_credential_aliases_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
