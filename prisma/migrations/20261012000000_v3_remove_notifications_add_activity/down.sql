-- Reverse of the v3 upgrade: restore the notification layer exactly as it
-- existed at migration 20261010063255_add_notification_provider_id.

-- DropTable: activity events
DROP TABLE "ActivityEvent";

-- AlterTable: remove the activity "last visit" marker
ALTER TABLE "Shop" DROP COLUMN "activitySeenAt";

-- Restore digest/telegram keys stripped from shops.settings
-- (values cannot be recovered; keys return absent, which is the v2 default)
-- Re-add notification columns
ALTER TABLE "Shop" ADD COLUMN "notifyLocale" TEXT;
ALTER TABLE "Shop" ADD COLUMN "lastDigestAt" TIMESTAMP(3);
ALTER TABLE "Issue" ADD COLUMN "notifiedEmailAt" TIMESTAMP(3);
ALTER TABLE "Issue" ADD COLUMN "notifiedTelegramAt" TIMESTAMP(3);

-- CreateTable: notification log
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "providerId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable: telegram link tokens
CREATE TABLE "TelegramLinkToken" (
    "tokenHash" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "TelegramLinkToken_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationLog_shopId_channel_kind_periodKey_key" ON "NotificationLog"("shopId", "channel", "kind", "periodKey");
CREATE INDEX "NotificationLog_providerId_idx" ON "NotificationLog"("providerId");
CREATE INDEX "TelegramLinkToken_shopId_idx" ON "TelegramLinkToken"("shopId");

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TelegramLinkToken" ADD CONSTRAINT "TelegramLinkToken_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- (Deleted job rows cannot be restored; they belonged to removed features.)
