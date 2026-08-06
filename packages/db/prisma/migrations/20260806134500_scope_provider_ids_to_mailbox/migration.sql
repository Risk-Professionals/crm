ALTER TABLE "emailThread"
ADD COLUMN "providerUserId" TEXT;

UPDATE "emailThread" AS thread
SET "providerUserId" = source."syncedByUserId"
FROM (
  SELECT DISTINCT ON ("threadId") "threadId", "syncedByUserId"
  FROM "emailMessage"
  WHERE "syncedByUserId" IS NOT NULL
  ORDER BY "threadId", "sentAt" ASC
) AS source
WHERE source."threadId" = thread."id";

DROP INDEX "emailThread_provider_providerThreadId_key";
DROP INDEX "emailMessage_provider_providerMessageId_key";
DROP INDEX "calendarEvent_provider_providerEventId_key";

CREATE UNIQUE INDEX "emailThread_providerUserId_provider_providerThreadId_key"
ON "emailThread"("providerUserId", "provider", "providerThreadId");

CREATE UNIQUE INDEX "emailMessage_syncedByUserId_provider_providerMessageId_key"
ON "emailMessage"("syncedByUserId", "provider", "providerMessageId");

CREATE UNIQUE INDEX "calendarEvent_syncedByUserId_provider_providerEventId_key"
ON "calendarEvent"("syncedByUserId", "provider", "providerEventId");
