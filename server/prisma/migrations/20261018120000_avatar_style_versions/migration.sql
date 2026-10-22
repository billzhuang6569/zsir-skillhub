CREATE TABLE "avatar_style_versions" (
    "styleId" TEXT NOT NULL,
    "styleVersion" INTEGER NOT NULL CHECK ("styleVersion" > 0),
    "content" TEXT NOT NULL,
    "contentSha256" CHAR(64) NOT NULL CHECK ("contentSha256" ~ '^[a-f0-9]{64}$'),
    "source" TEXT NOT NULL CHECK ("source" IN ('repository', 'fetched')),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "avatar_style_versions_pkey" PRIMARY KEY ("styleId", "styleVersion")
);

CREATE FUNCTION reject_avatar_style_version_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'avatar_style_version_immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER avatar_style_versions_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON "avatar_style_versions"
FOR EACH STATEMENT EXECUTE FUNCTION reject_avatar_style_version_mutation();
