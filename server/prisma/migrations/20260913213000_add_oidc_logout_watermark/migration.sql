-- A logout can arrive before SkillHub has created an ExternalIdentity row.
-- Keep the issuer/subject revocation watermark independently so a token issued
-- before that logout can never create or authenticate a later mapping.
CREATE TABLE "oidc_logout_watermarks" (
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "latestLogoutAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oidc_logout_watermarks_pkey" PRIMARY KEY ("issuer", "subject")
);

-- Preserve revocation state written by the first ExternalIdentity migration.
-- No User row, business foreign key, role, or product asset is modified.
INSERT INTO "oidc_logout_watermarks" (
    "issuer",
    "subject",
    "latestLogoutAt",
    "createdAt",
    "updatedAt"
)
SELECT
    "issuer",
    "subject",
    MAX("lastLogoutAt"),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "external_identities"
WHERE "lastLogoutAt" IS NOT NULL
GROUP BY "issuer", "subject"
ON CONFLICT ("issuer", "subject") DO UPDATE
SET
    "latestLogoutAt" = GREATEST(
        "oidc_logout_watermarks"."latestLogoutAt",
        EXCLUDED."latestLogoutAt"
    ),
    "updatedAt" = CURRENT_TIMESTAMP;

-- Deployment currently applies migrations before stopping the previous
-- process. Mirror any lastLogoutAt written by that process into the new table
-- until every instance has switched to the independent watermark path.
CREATE FUNCTION "sync_oidc_logout_watermark_from_identity"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."lastLogoutAt" IS NOT NULL THEN
        INSERT INTO "oidc_logout_watermarks" (
            "issuer",
            "subject",
            "latestLogoutAt",
            "createdAt",
            "updatedAt"
        )
        VALUES (
            NEW."issuer",
            NEW."subject",
            NEW."lastLogoutAt",
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT ("issuer", "subject") DO UPDATE
        SET
            "latestLogoutAt" = GREATEST(
                "oidc_logout_watermarks"."latestLogoutAt",
                EXCLUDED."latestLogoutAt"
            ),
            "updatedAt" = CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "external_identities_sync_logout_watermark"
AFTER INSERT OR UPDATE OF "lastLogoutAt" ON "external_identities"
FOR EACH ROW
EXECUTE FUNCTION "sync_oidc_logout_watermark_from_identity"();
