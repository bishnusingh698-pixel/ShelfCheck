-- AlterTable
ALTER TABLE "NotificationLog" ADD COLUMN     "providerId" TEXT;

-- CreateIndex
CREATE INDEX "NotificationLog_providerId_idx" ON "NotificationLog"("providerId");
