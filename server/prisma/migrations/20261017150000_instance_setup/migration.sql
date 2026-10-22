CREATE TABLE "instance_setup" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "initializedAt" TIMESTAMP(3),
    "codeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "codeAttempts" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "instance_setup_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "instance_setup_singleton" CHECK ("id" = 1)
);

INSERT INTO "instance_setup" ("id", "updatedAt") VALUES (1, CURRENT_TIMESTAMP);
