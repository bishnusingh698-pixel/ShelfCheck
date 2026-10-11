-- Down migration for 20261011_remove_email_telegram_notifications.
-- Recreates the tables and columns exactly as they were before the removal
-- (structure only: dropped rows cannot be restored, which is expected for a
-- feature removal — the down path exists so a deploy can be rolled back to
-- the previous app version, which then finds a schema it understands).

ALTER TABLE "Shop" ADD COLUMN "notifyLocale" TEXT;
ALTER TABLE "Shop" ADD COLUMN "lastDigestAt" TIMESTAMP(3);

ALTER TABLE "Issue" ADD COLUMN "notifiedEmailAt" TIMESTAMP(3);
ALTER TABLE "Issue" ADD COLUMN "notifiedTelegramAt" TIMESTAMP(3);

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

CREATE TABLE "TelegramLinkToken" (
    "tokenHash" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "TelegramLinkToken_pkey" PRIMARY KEY ("tokenHash")
);

CREATE UNIQUE INDEX "NotificationLog_shopId_channel_kind_periodKey_key"
    ON "NotificationLog"("shopId", "channel", "kind", "periodKey");
CREATE INDEX "NotificationLog_providerId_idx" ON "NotificationLog"("providerId");

ALTER TABLE "NotificationLog"
    ADD CONSTRAINT "NotificationLog_shopId_fkey" FOREIGN KEY ("shopId")
    REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TelegramLinkToken"
    ADD CONSTRAINT "TelegramLinkToken_shopId_fkey" FOREIGN KEY ("shopId")
    REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
