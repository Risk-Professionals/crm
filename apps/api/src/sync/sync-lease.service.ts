import {
	type Db,
	type MailboxSyncModel as MailboxSync,
	MailboxSyncStatus,
	type Prisma,
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
	userId?: string;
};

export type ExclusiveLease = {
	acquired: boolean;
	rows: MailboxSync[];
};

@Injectable()
export class SyncLeaseService {
	constructor(@InjectDatabase() private readonly db: Db) {}

	async claimDue(options: ClaimDueOptions): Promise<MailboxSync[]> {
		const leaseExpiresAt = new Date(options.now.getTime() + options.leaseMs);
		const userId = options.userId ?? null;

		return this.db.$queryRaw<MailboxSync[]>`
			WITH candidates AS (
				SELECT "id"
				FROM "mailboxSync"
				WHERE "provider" = ${options.provider}::"SyncProvider"
					AND "resource" = ${options.resource}::"SyncResource"
					AND (${userId}::TEXT IS NULL OR "userId" = ${userId})
					AND "syncStatus" IS DISTINCT FROM ${MailboxSyncStatus.NEEDS_RECONNECT}::"MailboxSyncStatus"
					AND ("syncStatus" IS DISTINCT FROM ${MailboxSyncStatus.FAILED}::"MailboxSyncStatus" OR "retryCount" < 8)
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

	async claimUserExclusive(options: {
		userId: string;
		provider: SyncProvider;
		owner: string;
		now: Date;
		leaseMs: number;
	}): Promise<ExclusiveLease> {
		return this.db.$transaction(async (tx) => {
			const rows = await tx.$queryRaw<MailboxSync[]>`
				SELECT *
				FROM "mailboxSync"
				WHERE "userId" = ${options.userId}
					AND "provider" = ${options.provider}::"SyncProvider"
				FOR UPDATE
			`;
			if (
				rows.some(
					(row) =>
						row.leaseOwner &&
						row.leaseOwner !== options.owner &&
						row.leaseExpiresAt &&
						row.leaseExpiresAt > options.now,
				)
			)
				return { acquired: false, rows: [] };
			const leaseExpiresAt = new Date(options.now.getTime() + options.leaseMs);
			await tx.mailboxSync.updateMany({
				where: {
					userId: options.userId,
					provider: options.provider,
				},
				data: { leaseOwner: options.owner, leaseExpiresAt },
			});
			return {
				acquired: true,
				rows: rows.map((row) => ({
					...row,
					leaseOwner: options.owner,
					leaseExpiresAt,
				})),
			};
		});
	}

	async withUserExclusive<T>(
		userId: string,
		provider: SyncProvider,
		owner: string,
		write: (tx: Prisma.TransactionClient) => Promise<T>,
	): Promise<T> {
		return this.db.$transaction(
			async (tx) => {
				const rows = await tx.$queryRaw<
					Array<{ id: string; leaseOwner: string | null; active: boolean }>
				>`
					SELECT
						"id",
						"leaseOwner",
						"leaseExpiresAt" > NOW() AS "active"
					FROM "mailboxSync"
					WHERE "userId" = ${userId}
						AND "provider" = ${provider}::"SyncProvider"
					FOR UPDATE
				`;
				if (
					rows.length === 0 ||
					rows.some((row) => row.leaseOwner !== owner || !row.active)
				)
					throw new Error("The exclusive Microsoft lease was lost.");
				return write(tx);
			},
			{ timeout: 120_000 },
		);
	}

	async release(id: string, owner: string): Promise<boolean> {
		const result = await this.db.mailboxSync.updateMany({
			where: { id, leaseOwner: owner },
			data: { leaseOwner: null, leaseExpiresAt: null },
		});
		return result.count === 1;
	}

	async releaseUser(
		userId: string,
		provider: SyncProvider,
		owner: string,
	): Promise<void> {
		await this.db.mailboxSync.updateMany({
			where: { userId, provider, leaseOwner: owner },
			data: { leaseOwner: null, leaseExpiresAt: null },
		});
	}
}
