-- Preserve every existing SkillHub user id and business foreign key. The
-- unified account issuer/subject is an additive mapping only.
CREATE TABLE "external_identities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "linkMethod" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLogoutAt" TIMESTAMP(3),

    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "external_identities_issuer_subject_key"
ON "external_identities"("issuer", "subject");

CREATE UNIQUE INDEX "external_identities_userId_issuer_key"
ON "external_identities"("userId", "issuer");

CREATE INDEX "external_identities_userId_idx"
ON "external_identities"("userId");

ALTER TABLE "external_identities"
ADD CONSTRAINT "external_identities_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
