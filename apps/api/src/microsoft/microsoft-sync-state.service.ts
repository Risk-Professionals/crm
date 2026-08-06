import {
	type Db,
	GoogleSyncStatus,
	type MailboxSyncModel as MailboxSync,
	MailboxSyncStatus,
	type Prisma,
	SyncProvider,
	SyncResource,
} from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import { MAIL_FOLDERS, type MailFolder } from "./mail.client";

export type MicrosoftSyncSource = "mail" | "calendar";

const sourceForFolder = (folder: MailFolder) => `microsoft:mail:${folder}`;
const MAX_RETRY_MS = 15 * 60_000;

export class SyncLeaseLostError extends Error {
	constructor(id: string) {
		super(`Microsoft sync lease was lost for ${id}.`);
		this.name = "SyncLeaseLostError";
	}
}

@Injectable()
export class MicrosoftSyncStateService {
	private readonly logger = new Logger(MicrosoftSyncStateService.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async ensureForUser(userId: string): Promise<void> {
		const now = new Date();
		for (const folder of MAIL_FOLDERS) {
			await this.db.mailboxSync.upsert({
				where: { userId_source: { userId, source: sourceForFolder(folder) } },
				create: {
					userId,
					source: sourceForFolder(folder),
					status: GoogleSyncStatus.IDLE,
					provider: SyncProvider.MICROSOFT,
					resource: SyncResource.MAIL,
					scopeKey: `folder:${folder}`,
					folderId: folder,
					syncStatus: MailboxSyncStatus.IDLE,
					autoCreate: false,
					ingestAfter: now,
				},
				update: {
					provider: SyncProvider.MICROSOFT,
					resource: SyncResource.MAIL,
					scopeKey: `folder:${folder}`,
					folderId: folder,
				},
			});
		}

		const end = new Date(now);
		end.setUTCDate(end.getUTCDate() + 180);
		await this.db.mailboxSync.upsert({
			where: {
				userId_source: { userId, source: "microsoft:calendar:default" },
			},
			create: {
				userId,
				source: "microsoft:calendar:default",
				status: GoogleSyncStatus.IDLE,
				provider: SyncProvider.MICROSOFT,
				resource: SyncResource.CALENDAR,
				scopeKey: "calendar:default",
				syncStatus: MailboxSyncStatus.IDLE,
				autoCreate: true,
				windowStart: now,
				windowEnd: end,
			},
			update: {
				provider: SyncProvider.MICROSOFT,
				resource: SyncResource.CALENDAR,
				scopeKey: "calendar:default",
			},
		});
	}

	listForUser(userId: string): Promise<MailboxSync[]> {
		return this.db.mailboxSync.findMany({
			where: { userId, provider: SyncProvider.MICROSOFT },
			orderBy: [{ resource: "asc" }, { scopeKey: "asc" }],
		});
	}

	async ensureIngestAfter(
		id: string,
		boundary: Date,
		owner?: string | null,
	): Promise<Date> {
		await this.updateOwned(
			id,
			owner,
			{ ingestAfter: boundary },
			{ ingestAfter: null },
		);
		const row = await this.db.mailboxSync.findUniqueOrThrow({
			where: { id },
			select: { ingestAfter: true },
		});
		return row.ingestAfter ?? boundary;
	}

	async markIdle(
		id: string,
		update: Prisma.MailboxSyncUpdateInput = {},
		owner?: string | null,
	): Promise<void> {
		await this.updateOwned(id, owner, {
			status: GoogleSyncStatus.IDLE,
			syncStatus: MailboxSyncStatus.IDLE,
			lastError: null,
			retryAfter: null,
			...update,
		});
	}

	async commitPage(
		id: string,
		links: { next?: string | null; delta?: string | null },
		owner?: string | null,
	): Promise<void> {
		await this.updateOwned(id, owner, {
			providerPageCursor: links.next ?? null,
			...(links.delta ? { providerCursor: links.delta } : {}),
			status: GoogleSyncStatus.IDLE,
			syncStatus: MailboxSyncStatus.IDLE,
			lastError: null,
			retryAfter: null,
			retryCount: 0,
			...(links.delta ? { lastSyncedAt: new Date() } : {}),
		});
	}

	async beginReconciliation(
		id: string,
		reason: string,
		owner?: string | null,
	): Promise<Date> {
		const startedAt = new Date();
		this.logger.warn({
			message: "Microsoft delta cursor invalidated; reconciliation started",
			syncId: id,
			reason,
		});
		await this.updateOwned(id, owner, {
			providerCursor: null,
			providerPageCursor: null,
			reconciliationStartedAt: startedAt,
			status: GoogleSyncStatus.IDLE,
			syncStatus: MailboxSyncStatus.IDLE,
			lastError: null,
		});
		return startedAt;
	}

	async finishReconciliation(id: string, owner?: string | null): Promise<void> {
		await this.updateOwned(id, owner, { reconciliationStartedAt: null });
	}

	async restoreConnected(userId: string, connectedAt: Date): Promise<void> {
		await this.db.mailboxSync.updateMany({
			where: {
				userId,
				provider: SyncProvider.MICROSOFT,
				syncStatus: MailboxSyncStatus.NEEDS_RECONNECT,
				updatedAt: { lt: connectedAt },
			},
			data: {
				status: GoogleSyncStatus.IDLE,
				syncStatus: MailboxSyncStatus.IDLE,
				lastError: null,
				retryCount: 0,
			},
		});
	}

	async markNeedsReconnect(
		id: string,
		reason: string,
		owner?: string | null,
	): Promise<void> {
		await this.updateOwned(id, owner, {
			status: GoogleSyncStatus.NEEDS_RECONNECT,
			syncStatus: MailboxSyncStatus.NEEDS_RECONNECT,
			lastError: reason,
			retryAfter: null,
		});
	}

	async markRateLimited(
		id: string,
		retryAfterMs: number,
		owner?: string | null,
	): Promise<void> {
		await this.updateOwned(id, owner, {
			status: GoogleSyncStatus.IDLE,
			syncStatus: MailboxSyncStatus.IDLE,
			retryAfter: new Date(Date.now() + retryAfterMs),
		});
	}

	async markFailed(
		id: string,
		reason: string,
		owner?: string | null,
	): Promise<void> {
		const row = await this.db.mailboxSync.findUnique({
			where: { id },
			select: { retryCount: true, leaseOwner: true, leaseExpiresAt: true },
		});
		if (!row) throw new SyncLeaseLostError(id);
		this.assertOwner(id, owner, row);
		const retryCount = row.retryCount + 1;
		const retryMs = Math.min(
			30_000 * 2 ** Math.min(retryCount - 1, 5),
			MAX_RETRY_MS,
		);
		await this.updateOwned(id, owner, {
			status: GoogleSyncStatus.FAILED,
			syncStatus: MailboxSyncStatus.FAILED,
			lastError: reason,
			retryCount,
			retryAfter: new Date(Date.now() + retryMs),
		});
	}

	async retryFailedForUser(userId: string): Promise<void> {
		await this.db.mailboxSync.updateMany({
			where: {
				userId,
				provider: SyncProvider.MICROSOFT,
				syncStatus: MailboxSyncStatus.FAILED,
			},
			data: { retryCount: 0, retryAfter: null },
		});
	}

	async assertOwned(id: string, owner?: string | null): Promise<void> {
		if (!owner) return;
		const row = await this.db.mailboxSync.findUnique({
			where: { id },
			select: { leaseOwner: true, leaseExpiresAt: true },
		});
		if (!row) throw new SyncLeaseLostError(id);
		this.assertOwner(id, owner, row);
	}

	async withBusinessWrite<T>(
		id: string,
		owner: string | null | undefined,
		write: (tx: Prisma.TransactionClient) => Promise<T>,
	): Promise<T> {
		if (!owner) throw new SyncLeaseLostError(id);
		return this.db.$transaction(
			async (tx) => {
				const owned = await tx.$queryRaw<Array<{ id: string }>>`
					SELECT "id"
					FROM "mailboxSync"
					WHERE "id" = ${id}
						AND "leaseOwner" = ${owner}
						AND "leaseExpiresAt" > NOW()
					FOR UPDATE
				`;
				if (owned.length !== 1) throw new SyncLeaseLostError(id);
				return write(tx);
			},
			{ timeout: 120_000 },
		);
	}

	async setAutoCreate(
		userId: string,
		resource: SyncResource,
		enabled: boolean,
	): Promise<void> {
		await this.db.mailboxSync.updateMany({
			where: { userId, provider: SyncProvider.MICROSOFT, resource },
			data: { autoCreate: enabled },
		});
	}

	async removeOwned(
		userId: string,
		owner: string,
		client: Prisma.TransactionClient = this.db,
	): Promise<void> {
		await client.mailboxSync.deleteMany({
			where: { userId, provider: SyncProvider.MICROSOFT, leaseOwner: owner },
		});
	}

	private async updateOwned(
		id: string,
		owner: string | null | undefined,
		data: Prisma.MailboxSyncUpdateInput,
		extra: Prisma.MailboxSyncWhereInput = {},
	): Promise<void> {
		const result = await this.db.mailboxSync.updateMany({
			where: {
				id,
				...extra,
				...(owner
					? { leaseOwner: owner, leaseExpiresAt: { gt: new Date() } }
					: {}),
			},
			data,
		});
		if (result.count === 0 && owner) throw new SyncLeaseLostError(id);
	}

	private assertOwner(
		id: string,
		owner: string | null | undefined,
		row: { leaseOwner: string | null; leaseExpiresAt: Date | null },
	): void {
		if (
			owner &&
			(row.leaseOwner !== owner ||
				!row.leaseExpiresAt ||
				row.leaseExpiresAt <= new Date())
		)
			throw new SyncLeaseLostError(id);
	}
}
