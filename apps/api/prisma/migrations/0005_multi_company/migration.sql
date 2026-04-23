-- CreateTable
CREATE TABLE "Company" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "logoFileId" TEXT,
    "logoFileUniqueId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_slug_key" ON "Company"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Company_inviteCode_key" ON "Company"("inviteCode");

-- Seed default tenant so existing records stay accessible
INSERT INTO "Company" ("name", "slug", "inviteCode")
VALUES ('Beauty Visuals', 'default', 'default-invite')
ON CONFLICT DO NOTHING;

-- AlterTable: Admins and clients now belong to a company
ALTER TABLE "AdminInfo" ADD COLUMN "companyId" INTEGER;
UPDATE "AdminInfo"
SET "companyId" = COALESCE("companyId", (SELECT "id" FROM "Company" WHERE "slug" = 'default' LIMIT 1));
ALTER TABLE "AdminInfo" ALTER COLUMN "companyId" SET NOT NULL;

ALTER TABLE "ClientUser" ADD COLUMN "companyId" INTEGER;
UPDATE "ClientUser"
SET "companyId" = COALESCE("companyId", (SELECT "id" FROM "Company" WHERE "slug" = 'default' LIMIT 1));
ALTER TABLE "ClientUser" ALTER COLUMN "companyId" SET NOT NULL;

-- Content, notifications and engagement are scoped per company
ALTER TABLE "PhotoBatch" ADD COLUMN "companyId" INTEGER;
UPDATE "PhotoBatch"
SET "companyId" = COALESCE("companyId", (SELECT "id" FROM "Company" WHERE "slug" = 'default' LIMIT 1));
ALTER TABLE "PhotoBatch" ALTER COLUMN "companyId" SET NOT NULL;

ALTER TABLE "Photo" ADD COLUMN "companyId" INTEGER;
UPDATE "Photo"
SET "companyId" = COALESCE("companyId", (SELECT "id" FROM "Company" WHERE "slug" = 'default' LIMIT 1));
ALTER TABLE "Photo" ALTER COLUMN "companyId" SET NOT NULL;

ALTER TABLE "Notification" ADD COLUMN "companyId" INTEGER;
UPDATE "Notification"
SET "companyId" = COALESCE("companyId", (SELECT "id" FROM "Company" WHERE "slug" = 'default' LIMIT 1));
ALTER TABLE "Notification" ALTER COLUMN "companyId" SET NOT NULL;

ALTER TABLE "AppointmentRequest" ADD COLUMN "companyId" INTEGER;
UPDATE "AppointmentRequest"
SET "companyId" = COALESCE("companyId", (SELECT "id" FROM "Company" WHERE "slug" = 'default' LIMIT 1));
ALTER TABLE "AppointmentRequest" ALTER COLUMN "companyId" SET NOT NULL;

ALTER TABLE "FeedbackResponse" ADD COLUMN "companyId" INTEGER;
UPDATE "FeedbackResponse"
SET "companyId" = COALESCE("companyId", (SELECT "id" FROM "Company" WHERE "slug" = 'default' LIMIT 1));
ALTER TABLE "FeedbackResponse" ALTER COLUMN "companyId" SET NOT NULL;

ALTER TABLE "LoyaltyReward" ADD COLUMN "companyId" INTEGER;
UPDATE "LoyaltyReward"
SET "companyId" = COALESCE("companyId", (SELECT "id" FROM "Company" WHERE "slug" = 'default' LIMIT 1));
ALTER TABLE "LoyaltyReward" ALTER COLUMN "companyId" SET NOT NULL;

-- Lookbook topics can be either global (NULL) or tenant specific
ALTER TABLE "LookbookTopic" ADD COLUMN "companyId" INTEGER;

-- Foreign keys
ALTER TABLE "AdminInfo" ADD CONSTRAINT "AdminInfo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClientUser" ADD CONSTRAINT "ClientUser_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PhotoBatch" ADD CONSTRAINT "PhotoBatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Photo" ADD CONSTRAINT "Photo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppointmentRequest" ADD CONSTRAINT "AppointmentRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FeedbackResponse" ADD CONSTRAINT "FeedbackResponse_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoyaltyReward" ADD CONSTRAINT "LoyaltyReward_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LookbookTopic" ADD CONSTRAINT "LookbookTopic_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Helpful indexes for scoping
CREATE INDEX "AdminInfo_companyId_idx" ON "AdminInfo"("companyId");
CREATE INDEX "ClientUser_companyId_idx" ON "ClientUser"("companyId");
CREATE INDEX "PhotoBatch_companyId_idx" ON "PhotoBatch"("companyId");
CREATE INDEX "Photo_companyId_idx" ON "Photo"("companyId");
CREATE INDEX "Notification_companyId_idx" ON "Notification"("companyId");
CREATE INDEX "AppointmentRequest_companyId_idx" ON "AppointmentRequest"("companyId");
CREATE INDEX "FeedbackResponse_companyId_idx" ON "FeedbackResponse"("companyId");
CREATE INDEX "LoyaltyReward_companyId_idx" ON "LoyaltyReward"("companyId");
CREATE INDEX "LookbookTopic_companyId_idx" ON "LookbookTopic"("companyId");
