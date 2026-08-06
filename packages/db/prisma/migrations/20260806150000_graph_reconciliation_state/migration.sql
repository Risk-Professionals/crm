ALTER TABLE "mailboxSync"
ADD COLUMN "reconciliationStartedAt" TIMESTAMP(3),
ADD COLUMN "ingestAfter" TIMESTAMP(3);

ALTER TABLE "emailMessage"
ADD COLUMN "providerFolderId" TEXT,
ADD COLUMN "providerSeenAt" TIMESTAMP(3);

ALTER TABLE "calendarEvent"
ADD COLUMN "providerSeenAt" TIMESTAMP(3);

CREATE INDEX "emailMessage_syncedByUserId_provider_providerFolderId_idx"
ON "emailMessage"("syncedByUserId", "provider", "providerFolderId");

CREATE INDEX "calendarEvent_syncedByUserId_provider_providerSeenAt_idx"
ON "calendarEvent"("syncedByUserId", "provider", "providerSeenAt");
