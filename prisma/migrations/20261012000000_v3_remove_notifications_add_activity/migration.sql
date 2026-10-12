/*
  v3 upgrade: remove the notification layer (email digest + Telegram) and add
  the in-app activity system. See docs/phase-reports/upgrade-v3.md.

  Order matters: jobs of removed kinds are deleted BEFORE the tables they
  reference go away; shops.settings jsonb keys are stripped in place.
*/

-- Delete pending jobs of removed kinds
DELETE FROM "Job" WHERE "kind" IN ('digest_send', 'notify_new_issues', 'telegram_alert');

-- DropTable (removed features)
DROP TABLE "TelegramLinkToken";
DROP TABLE "NotificationLog";

-- AlterTable: drop notification columns
ALTER TABLE "Shop" DROP COLUMN "notifyLocale";
ALTER TABLE "Shop" DROP COLUMN "lastDigestAt";
ALTER TABLE "Issue" DROP COLUMN "notifiedEmailAt";
ALTER TABLE "Issue" DROP COLUMN "notifiedTelegramAt";

-- Strip digest/telegram keys from shops.settings jsonb
UPDATE "Shop" SET "settings" = "settings" - 'digest' - 'telegram';

-- AlterTable: add the activity "last visit" marker
ALTER TABLE "Shop" ADD COLUMN "activitySeenAt" TIMESTAMP(3);

-- CreateTable: activity events (in-app alerts)
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "coalesceBucket" TIMESTAMP(3),

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityEvent_shopId_createdAt_idx" ON "ActivityEvent"("shopId", "createdAt" DESC);

-- ## Raw SQL: one coalesced row per shop/kind/15-min bucket (spec <in_app_alerts>).
-- The partial unique index makes merging atomic: two concurrent webhooks
-- race, one inserts, the loser falls into the UPDATE path.
CREATE UNIQUE INDEX "ActivityEvent_coalesce_bucket_key" ON "ActivityEvent"("shopId", "kind", "coalesceBucket")
  WHERE "coalesceBucket" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
