import {
	type Db,
	type MailboxSyncModel as MailboxSync,
	MailboxSyncStatus,
	SyncProvider,
	SyncResource,
} from "@crm/db";
import { Injectable } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";

export type ClaimDueOptions = {
	provider: SyncProvider;
	resource: SyncResource;
	owner: string;
	now: Date;
	leaseMs: number;
	limit: number;
};

@Injectable()
export class SyncLeaseService {
	constructor(@InjectDatabase() private readonly db: Db) {}

	async claimDue(options: ClaimDueOptions): Promise<MailboxSync[]> {
		const leaseExpiresAt = new Date(options.now.getTime() + options.leaseMs);

		return this.db.$queryRaw<MailboxSync[]>`
			WITH candidates AS (
				SELECT "id"
				FROM "mailboxSync"
				WHERE "provider" = ${options.provider}::"SyncProvider"
					AND "resource" = ${options.resource}::"SyncResource"
					AND "syncStatus" IS DISTINCT FROM ${MailboxSyncStatus.NEEDS_RECONNECT}::"MailboxSyncStatus"
					AND ("retryAfter" IS NULL OR "retryAfter" <= ${options.now})
					AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${options.now})
				ORDER BY "lastSyncedAt" ASC NULLS FIRST, "createdAt" ASC
				FOR UPDATE SKIP LOCKED
				LIMIT ${options.limit}
			)
			UPDATE "mailboxSync" AS sync
			SET
				"leaseOwner" = ${options.owner},
				"leaseExpiresAt" = ${leaseExpiresAt},
				"syncStatus" = ${MailboxSyncStatus.RUNNING}::"MailboxSyncStatus",
				"updatedAt" = NOW()
			FROM candidates
			WHERE sync."id" = candidates."id"
			RETURNING sync.*
		`;
	}

	async release(id: string, owner: string): Promise<boolean> {
		const result = await this.db.mailboxSync.updateMany({
			where: { id, leaseOwner: owner },
			data: { leaseOwner: null, leaseExpiresAt: null },
		});

		return result.count === 1;
	}
}
