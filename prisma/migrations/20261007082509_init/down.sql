-- Down migration for 20261007082509_init (hand-written; Prisma is forward-only).
-- Reverses every statement in migration.sql in reverse order.

DROP INDEX IF EXISTS "Issue_shopId_open_partial";
DROP INDEX IF EXISTS "Job_dedupeKey_pending_partial";
DROP INDEX IF EXISTS "Scan_shopId_active_partial";

ALTER TABLE "TelegramLinkToken" DROP CONSTRAINT IF EXISTS "TelegramLinkToken_shopId_fkey";
ALTER TABLE "NotificationLog" DROP CONSTRAINT IF EXISTS "NotificationLog_shopId_fkey";
ALTER TABLE "Job" DROP CONSTRAINT IF EXISTS "Job_shopId_fkey";
ALTER TABLE "WebhookEvent" DROP CONSTRAINT IF EXISTS "WebhookEvent_shopId_fkey";
ALTER TABLE "IgnoreRule" DROP CONSTRAINT IF EXISTS "IgnoreRule_shopId_fkey";
ALTER TABLE "Issue" DROP CONSTRAINT IF EXISTS "Issue_shopId_fkey";
ALTER TABLE "VariantIndex" DROP CONSTRAINT IF EXISTS "VariantIndex_shopId_fkey";
ALTER TABLE "Scan" DROP CONSTRAINT IF EXISTS "Scan_shopId_fkey";

DROP INDEX IF EXISTS "NotificationLog_shopId_channel_kind_periodKey_key";
DROP INDEX IF EXISTS "Job_kind_status_idx";
DROP INDEX IF EXISTS "Job_status_runAt_idx";
DROP INDEX IF EXISTS "WebhookEvent_webhookId_key";
DROP INDEX IF EXISTS "IgnoreRule_shopId_scope_idx";
DROP INDEX IF EXISTS "Issue_shopId_type_status_idx";
DROP INDEX IF EXISTS "Issue_shopId_groupKey_idx";
DROP INDEX IF EXISTS "Issue_shopId_status_severity_idx";
DROP INDEX IF EXISTS "Issue_shopId_type_variantGid_groupKey_key";
DROP INDEX IF EXISTS "VariantIndex_shopId_productGid_idx";
DROP INDEX IF EXISTS "VariantIndex_shopId_inventoryItemId_idx";
DROP INDEX IF EXISTS "VariantIndex_shopId_barcode_idx";
DROP INDEX IF EXISTS "VariantIndex_shopId_skuNorm_idx";
ALTER TABLE "VariantIndex" DROP CONSTRAINT IF EXISTS "VariantIndex_pkey";
DROP INDEX IF EXISTS "Scan_shopId_createdAt_idx";
DROP INDEX IF EXISTS "Scan_shopId_status_idx";
DROP INDEX IF EXISTS "Shop_shopDomain_key";
DROP INDEX IF EXISTS "Shop_uninstalledAt_idx";
DROP INDEX IF EXISTS "Session_shop_idx";

DROP TABLE IF EXISTS "RateLimitBucket";
DROP TABLE IF EXISTS "TelegramLinkToken";
DROP TABLE IF EXISTS "NotificationLog";
DROP TABLE IF EXISTS "Job";
DROP TABLE IF EXISTS "WebhookEvent";
DROP TABLE IF EXISTS "IgnoreRule";
DROP TABLE IF EXISTS "Issue";
DROP TABLE IF EXISTS "VariantIndex";
DROP TABLE IF EXISTS "Scan";
DROP TABLE IF EXISTS "Shop";
DROP TABLE IF EXISTS "Session";
