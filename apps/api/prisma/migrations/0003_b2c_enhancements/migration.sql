-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('requested', 'confirmed', 'declined', 'completed');

-- CreateEnum
CREATE TYPE "FeedbackChoice" AS ENUM ('love', 'tweak');

-- AlterTable
ALTER TABLE "ClientUser"
  ADD COLUMN "loyaltyPoints" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "streakCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastActivityAt" TIMESTAMP(3),
  ADD COLUMN "lastRewardedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LookbookTopic" (
    "id" SERIAL NOT NULL,
    "keyword" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "batchId" INTEGER,
    "heroPhotoFileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LookbookTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentRequest" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "desiredAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'requested',
    "confirmedAt" TIMESTAMP(3),
    "confirmationNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackResponse" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "appointmentId" INTEGER,
    "context" TEXT,
    "choice" "FeedbackChoice" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackResponse_appointmentId_key" ON "FeedbackResponse"("appointmentId");

-- CreateTable
CREATE TABLE "LoyaltyReward" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyReward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LookbookTopic_keyword_key" ON "LookbookTopic"("keyword");

-- AddForeignKey
ALTER TABLE "LookbookTopic" ADD CONSTRAINT "LookbookTopic_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PhotoBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentRequest" ADD CONSTRAINT "AppointmentRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ClientUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackResponse" ADD CONSTRAINT "FeedbackResponse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ClientUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackResponse" ADD CONSTRAINT "FeedbackResponse_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "AppointmentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyReward" ADD CONSTRAINT "LoyaltyReward_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ClientUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
