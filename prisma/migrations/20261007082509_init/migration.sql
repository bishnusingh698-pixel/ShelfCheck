-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "scopes" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "planStatus" TEXT,
    "planCheckedAt" TIMESTAMP(3),
    "uiLocale" TEXT,
    "notifyLocale" TEXT,
    "timezone" TEXT,
    "currency" TEXT,
    "shopHandle" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "lastScanAt" TIMESTAMP(3),
    "lastDigestAt" TIMESTAMP(3),

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scan" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "bulkOperationId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "variantsSeen" INTEGER NOT NULL DEFAULT 0,
    "variantsAnalyzed" INTEGER NOT NULL DEFAULT 0,
    "overCapCount" INTEGER NOT NULL DEFAULT 0,
    "healthScore" INTEGER,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantIndex" (
    "shopId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "inventoryItemId" TEXT,
    "productTitle" TEXT,
    "variantTitle" TEXT,
    "vendor" TEXT,
    "skuRaw" TEXT,
    "skuNorm" TEXT,
    "barcode" TEXT,
    "price" TEXT,
    "compareAtPrice" TEXT,
    "productStatus" TEXT,
    "isGiftCard" BOOLEAN NOT NULL DEFAULT false,
    "requiresShipping" BOOLEAN NOT NULL DEFAULT true,
    "weightPresent" BOOLEAN NOT NULL DEFAULT false,
    "costPresent" BOOLEAN NOT NULL DEFAULT false,
    "hasImage" BOOLEAN NOT NULL DEFAULT false,
    "variantCountOnProduct" INTEGER NOT NULL DEFAULT 1,
    "tracked" BOOLEAN NOT NULL DEFAULT false,
    "inventoryPolicy" TEXT,
    "inventoryQty" INTEGER,
    "publishedAnyChannel" BOOLEAN NOT NULL DEFAULT false,
    "fingerprint" TEXT,
    "seenScanId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantIndex_pkey" PRIMARY KEY ("shopId","variantGid")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "productGid" TEXT,
    "groupKey" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'open',
    "snoozedUntil" TIMESTAMP(3),
    "intentionalMemberCount" INTEGER,
    "firstSeenScanId" TEXT,
    "lastSeenScanId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "notifiedEmailAt" TIMESTAMP(3),
    "notifiedTelegramAt" TIMESTAMP(3),

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IgnoreRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "issueType" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IgnoreRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramLinkToken" (
    "tokenHash" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "TelegramLinkToken_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key","windowStart")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Shop_uninstalledAt_idx" ON "Shop"("uninstalledAt");

-- CreateIndex
CREATE INDEX "Scan_shopId_status_idx" ON "Scan"("shopId", "status");

-- CreateIndex
CREATE INDEX "Scan_shopId_createdAt_idx" ON "Scan"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "VariantIndex_shopId_skuNorm_idx" ON "VariantIndex"("shopId", "skuNorm");

-- CreateIndex
CREATE INDEX "VariantIndex_shopId_barcode_idx" ON "VariantIndex"("shopId", "barcode");

-- CreateIndex
CREATE INDEX "VariantIndex_shopId_inventoryItemId_idx" ON "VariantIndex"("shopId", "inventoryItemId");

-- CreateIndex
CREATE INDEX "VariantIndex_shopId_productGid_idx" ON "VariantIndex"("shopId", "productGid");

-- CreateIndex
CREATE INDEX "Issue_shopId_status_severity_idx" ON "Issue"("shopId", "status", "severity");

-- CreateIndex
CREATE INDEX "Issue_shopId_groupKey_idx" ON "Issue"("shopId", "groupKey");

-- CreateIndex
CREATE INDEX "Issue_shopId_type_status_idx" ON "Issue"("shopId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_shopId_type_variantGid_groupKey_key" ON "Issue"("shopId", "type", "variantGid", "groupKey");

-- CreateIndex
CREATE INDEX "IgnoreRule_shopId_scope_idx" ON "IgnoreRule"("shopId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_webhookId_key" ON "WebhookEvent"("webhookId");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE INDEX "Job_kind_status_idx" ON "Job"("kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationLog_shopId_channel_kind_periodKey_key" ON "NotificationLog"("shopId", "channel", "kind", "periodKey");

-- AddForeignKey
ALTER TABLE "Scan" ADD CONSTRAINT "Scan_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantIndex" ADD CONSTRAINT "VariantIndex_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IgnoreRule" ADD CONSTRAINT "IgnoreRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramLinkToken" ADD CONSTRAINT "TelegramLinkToken_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ## Raw SQL: partial unique indexes (not expressible in Prisma schema DSL)

-- One active scan per shop (queued/running/parsing). The real concurrency guard.
CREATE UNIQUE INDEX "Scan_shopId_active_partial" ON "Scan"("shopId")
  WHERE "status" IN ('queued', 'running', 'parsing');

-- Pending job dedupe: only one pending job per dedupe key.
CREATE UNIQUE INDEX "Job_dedupeKey_pending_partial" ON "Job"("dedupeKey")
  WHERE "status" = 'pending' AND "dedupeKey" IS NOT NULL;

-- Open issue fast path for dashboards (partial: only non-resolved).
CREATE INDEX "Issue_shopId_open_partial" ON "Issue"("shopId")
  WHERE "status" <> 'resolved';

