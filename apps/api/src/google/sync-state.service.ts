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
import { SYNC_SOURCES, type SyncSource } from "./google.constants";

const RESOURCE_FOR_SOURCE: Record<SyncSource, SyncResource> = {
	calendar: SyncResource.CALENDAR,
	gmail: SyncResource.MAIL,
};

const SCOPE_FOR_SOURCE: Record<SyncSource, string> = {
	calendar: "legacy:calendar",
	gmail: "legacy:gmail",
};

const STATUS_MAP: Record<GoogleSyncStatus, MailboxSyncStatus> = {
	[GoogleSyncStatus.IDLE]: MailboxSyncStatus.IDLE,
	[GoogleSyncStatus.RUNNING]: MailboxSyncStatus.RUNNING,
	[GoogleSyncStatus.NEEDS_RECONNECT]: MailboxSyncStatus.NEEDS_RECONNECT,
	[GoogleSyncStatus.FAILED]: MailboxSyncStatus.FAILED,
};

function googleRows(): Prisma.MailboxSyncWhereInput {
	return {
		source: { in: [...SYNC_SOURCES] },
		OR: [{ provider: SyncProvider.GOOGLE }, { provider: null }],
	};
}

@Injectable()
export class SyncStateService {
	private readonly logger = new Logger(SyncStateService.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async get(userId: string, source: SyncSource): Promise<MailboxSync | null> {
		return this.db.mailboxSync.findFirst({
			where: { ...googleRows(), userId, source },
		});
	}

	async listForUser(userId: string): Promise<MailboxSync[]> {
		return this.db.mailboxSync.findMany({
			where: { userId, ...googleRows() },
		});
	}

	async due(now: Date): Promise<MailboxSync[]> {
		return this.db.mailboxSync.findMany({
			where: {
				...googleRows(),
				status: { notIn: [GoogleSyncStatus.NEEDS_RECONNECT] },
				AND: [{ OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] }],
			},
			orderBy: [{ lastSyncedAt: { sort: "asc", nulls: "first" } }],
		});
	}

	async ensure(
		userId: string,
		source: SyncSource,
		options: { autoCreate: boolean },
	): Promise<MailboxSync> {
		return this.db.mailboxSync.upsert({
			where: { userId_source: { userId, source } },
			create: {
				userId,
				source,
				status: GoogleSyncStatus.IDLE,
				provider: SyncProvider.GOOGLE,
				resource: RESOURCE_FOR_SOURCE[source],
				scopeKey: SCOPE_FOR_SOURCE[source],
				syncStatus: MailboxSyncStatus.IDLE,
				autoCreate: options.autoCreate,
			},
			update: {
				status: GoogleSyncStatus.IDLE,
				provider: SyncProvider.GOOGLE,
				resource: RESOURCE_FOR_SOURCE[source],
				scopeKey: SCOPE_FOR_SOURCE[source],
				syncStatus: MailboxSyncStatus.IDLE,
				lastError: null,
				retryAfter: null,
			},
		});
	}

	async markRunning(id: string): Promise<void> {
		await this.db.mailboxSync.update({
			where: { id },
			data: {
				status: GoogleSyncStatus.RUNNING,
				syncStatus: MailboxSyncStatus.RUNNING,
				lastError: null,
			},
		});
	}

	async settle(
		id: string,
		update: {
			cursor?: string | null;
			status: GoogleSyncStatus;
		},
	): Promise<void> {
		await this.db.mailboxSync.update({
			where: { id },
			data: {
				status: update.status,
				syncStatus: STATUS_MAP[update.status],
				...(update.cursor !== undefined
					? { cursor: update.cursor, providerCursor: update.cursor }
					: {}),
				lastSyncedAt: new Date(),
				lastError: null,
				retryAfter: null,
			},
		});
	}

	async clearCursor(id: string, reason: string): Promise<void> {
		this.logger.warn({
			message: "Sync cursor invalidated — resuming from now",
			syncId: id,
			reason,
		});

		await this.db.mailboxSync.update({
			where: { id },
			data: {
				cursor: null,
				providerCursor: null,
				providerPageCursor: null,
				status: GoogleSyncStatus.IDLE,
				syncStatus: MailboxSyncStatus.IDLE,
				lastError: null,
			},
		});
	}

	async markNeedsReconnect(id: string, reason: string): Promise<void> {
		await this.db.mailboxSync.update({
			where: { id },
			data: {
				status: GoogleSyncStatus.NEEDS_RECONNECT,
				syncStatus: MailboxSyncStatus.NEEDS_RECONNECT,
				lastError: reason,
				retryAfter: null,
			},
		});
	}

	async markRateLimited(id: string, retryAfterMs: number): Promise<void> {
		await this.db.mailboxSync.update({
			where: { id },
			data: {
				status: GoogleSyncStatus.IDLE,
				syncStatus: MailboxSyncStatus.IDLE,
				retryAfter: new Date(Date.now() + retryAfterMs),
			},
		});
	}

	async markFailed(id: string, reason: string): Promise<void> {
		await this.db.mailboxSync.update({
			where: { id },
			data: {
				status: GoogleSyncStatus.FAILED,
				syncStatus: MailboxSyncStatus.FAILED,
				lastError: reason,
			},
		});
	}

	async setAutoCreate(
		userId: string,
		source: SyncSource,
		enabled: boolean,
	): Promise<void> {
		await this.db.mailboxSync.updateMany({
			where: { ...googleRows(), userId, source },
			data: { autoCreate: enabled },
		});
	}

	async remove(userId: string, source?: SyncSource): Promise<void> {
		await this.db.mailboxSync.deleteMany({
			where: { ...googleRows(), userId, ...(source ? { source } : {}) },
		});
	}
}
