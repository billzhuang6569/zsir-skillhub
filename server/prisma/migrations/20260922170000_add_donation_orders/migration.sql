CREATE TABLE "donation_orders" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "clientOperationId" TEXT NOT NULL,
  "outTradeNo" TEXT NOT NULL,
  "providerTradeNo" TEXT,
  "amountFen" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "payUrl" TEXT,
  "qrUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "donation_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "donation_orders_amountFen_check" CHECK ("amountFen" BETWEEN 100 AND 1000000),
  CONSTRAINT "donation_orders_status_check" CHECK ("status" IN ('pending', 'paid', 'failed'))
);

CREATE UNIQUE INDEX "donation_orders_outTradeNo_key" ON "donation_orders"("outTradeNo");
CREATE UNIQUE INDEX "donation_orders_providerTradeNo_key" ON "donation_orders"("providerTradeNo");
CREATE UNIQUE INDEX "donation_orders_userId_clientOperationId_key" ON "donation_orders"("userId", "clientOperationId");
CREATE INDEX "donation_orders_userId_createdAt_idx" ON "donation_orders"("userId", "createdAt");
ALTER TABLE "donation_orders" ADD CONSTRAINT "donation_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "admin_announcements" (
  "id" TEXT NOT NULL,
  "clientOperationId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "recipientCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_announcements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "admin_announcements_clientOperationId_key" ON "admin_announcements"("clientOperationId");
ALTER TABLE "admin_announcements" ADD CONSTRAINT "admin_announcements_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
