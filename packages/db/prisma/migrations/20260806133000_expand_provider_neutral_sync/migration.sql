CREATE TYPE "SyncProvider" AS ENUM ('GOOGLE', 'MICROSOFT');
CREATE TYPE "SyncResource" AS ENUM ('MAIL', 'CALENDAR');
CREATE TYPE "MailboxSyncStatus" AS ENUM ('IDLE', 'RUNNING', 'NEEDS_RECONNECT', 'FAILED');

ALTER TABLE "mailboxSync"
ADD COLUMN "provider" "SyncProvider",
ADD COLUMN "resource" "SyncResource",
ADD COLUMN "scopeKey" TEXT,
ADD COLUMN "syncStatus" "MailboxSyncStatus",
ADD COLUMN "providerCursor" TEXT,
ADD COLUMN "providerPageCursor" TEXT,
ADD COLUMN "folderId" TEXT,
ADD COLUMN "windowStart" TIMESTAMP(3),
ADD COLUMN "windowEnd" TIMESTAMP(3),
ADD COLUMN "leaseOwner" TEXT,
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;

UPDATE "mailboxSync"
SET
  "provider" = 'GOOGLE'::"SyncProvider",
  "resource" = CASE
    WHEN "source" = 'gmail' THEN 'MAIL'::"SyncResource"
    WHEN "source" = 'calendar' THEN 'CALENDAR'::"SyncResource"
    ELSE NULL
  END,
  "scopeKey" = CASE
    WHEN "source" = 'gmail' THEN 'legacy:gmail'
    WHEN "source" = 'calendar' THEN 'legacy:calendar'
    ELSE NULL
  END,
  "syncStatus" = "status"::text::"MailboxSyncStatus",
  "providerCursor" = "cursor"
WHERE "source" IN ('gmail', 'calendar');

ALTER TABLE "emailThread"
ADD COLUMN "provider" "SyncProvider",
ADD COLUMN "providerThreadId" TEXT;

UPDATE "emailThread" AS thread
SET
  "provider" = 'GOOGLE'::"SyncProvider",
  "providerThreadId" = thread."rootMessageId"
WHERE EXISTS (
  SELECT 1
  FROM "emailMessage" AS message
  WHERE message."threadId" = thread."id"
    AND message."gmailMessageId" IS NOT NULL
);

ALTER TABLE "emailMessage"
ADD COLUMN "provider" "SyncProvider",
ADD COLUMN "providerMessageId" TEXT,
ADD COLUMN "providerWebUrl" TEXT;

UPDATE "emailMessage"
SET
  "provider" = 'GOOGLE'::"SyncProvider",
  "providerMessageId" = "gmailMessageId"
WHERE "gmailMessageId" IS NOT NULL;

ALTER TABLE "calendarEvent"
ADD COLUMN "provider" "SyncProvider",
ADD COLUMN "providerEventId" TEXT,
ADD COLUMN "providerWebUrl" TEXT;

UPDATE "calendarEvent"
SET
  "provider" = 'GOOGLE'::"SyncProvider",
  "providerEventId" = "googleEventId"
WHERE "googleEventId" IS NOT NULL;

CREATE UNIQUE INDEX "mailboxSync_userId_provider_resource_scopeKey_key"
ON "mailboxSync"("userId", "provider", "resource", "scopeKey");

CREATE INDEX "mailboxSync_provider_resource_syncStatus_retryAfter_idx"
ON "mailboxSync"("provider", "resource", "syncStatus", "retryAfter");

CREATE INDEX "mailboxSync_leaseExpiresAt_idx"
ON "mailboxSync"("leaseExpiresAt");

CREATE UNIQUE INDEX "emailThread_provider_providerThreadId_key"
ON "emailThread"("provider", "providerThreadId");

CREATE UNIQUE INDEX "emailMessage_provider_providerMessageId_key"
ON "emailMessage"("provider", "providerMessageId");

CREATE UNIQUE INDEX "calendarEvent_provider_providerEventId_key"
ON "calendarEvent"("provider", "providerEventId");
