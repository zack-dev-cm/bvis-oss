-- Optional display string near the logo in the mini-app
ALTER TABLE "Company" ADD COLUMN "brandText" TEXT;

-- Preserve current branding by defaulting to the existing name
UPDATE "Company"
SET "brandText" = COALESCE("brandText", "name");
