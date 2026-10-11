-- Amendment 001: remove email digest + Telegram alerts from v1.
-- Deletes pending digest/telegram job kinds BEFORE dropping their tables so
-- the worker never meets an unknown kind, strips removed settings keys from
-- existing rows, then drops the notification tables and columns.
-- Forward-only in Prisma; see the hand-written down.sql for the reverse.

-- 1) Never leave a job the worker cannot handle.
DELETE FROM "Job" WHERE "kind" IN ('digest_send', 'notify_new_issues', 'telegram_alert');

-- 2) Remove removed-feature keys from existing settings rows (zod .strip()
--    tolerates them, but dropping the keys keeps rows clean).
UPDATE "Shop" SET "settings" = "settings" - 'digest' - 'telegram';

-- 3) Tables that only served notifications.
ALTER TABLE "NotificationLog" DROP CONSTRAINT "NotificationLog_shopId_fkey";
ALTER TABLE "TelegramLinkToken" DROP CONSTRAINT "TelegramLinkToken_shopId_fkey";

DROP TABLE "NotificationLog";
DROP TABLE "TelegramLinkToken";

-- 4) Columns that only served notifications.
ALTER TABLE "Issue" DROP COLUMN "notifiedEmailAt",
DROP COLUMN "notifiedTelegramAt";

ALTER TABLE "Shop" DROP COLUMN "lastDigestAt",
DROP COLUMN "notifyLocale";
