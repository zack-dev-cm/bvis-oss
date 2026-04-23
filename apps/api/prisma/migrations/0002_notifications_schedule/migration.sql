-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('pending', 'sent', 'failed');

-- AlterTable
ALTER TABLE "Notification"
ADD COLUMN "status" "NotificationStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN "deliverAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "sentAt" TIMESTAMP(3),
ADD COLUMN "error" TEXT;
