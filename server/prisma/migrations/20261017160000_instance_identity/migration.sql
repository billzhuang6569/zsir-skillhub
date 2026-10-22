CREATE TABLE "instance_identity" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "instanceId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "wrapIv" BYTEA NOT NULL,
    "wrapTag" BYTEA NOT NULL,
    "kekVersion" INTEGER NOT NULL,
    "aadVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "instance_identity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "instance_identity_singleton" CHECK ("id" = 1)
);

CREATE UNIQUE INDEX "instance_identity_instanceId_key" ON "instance_identity"("instanceId");
