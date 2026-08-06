import { randomUUID } from "node:crypto";
import {
	hasMicrosoftGraphScopes,
	isMicrosoftConfigured,
	MICROSOFT_PROVIDER_ID,
	signsInWithMicrosoft,
} from "@crm/auth";
import {
	type Db,
	MailboxSyncStatus,
	SyncProvider,
	SyncResource,
} from "@crm/db";
import {
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
} from "@nestjs/common";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { InjectDatabase } from "../database/database.constants";
import { SyncLeaseService } from "../sync/sync-lease.service";
import { MICROSOFT_RESOURCE_SCOPES } from "./microsoft.constants";
import { MicrosoftSyncStateService } from "./microsoft-sync-state.service";
import { MicrosoftTokenService } from "./microsoft-token.service";

export type MicrosoftSourceStatus = {
	source: "mail" | "calendar";
	connected: boolean;
	status: MailboxSyncStatus | null;
	lastSyncedAt: string | null;
	lastError: string | null;
	autoCreate: boolean;
};

export type MicrosoftConnectionStatus = {
	configured: boolean;
	linked: boolean;
	required: boolean;
	hasRefreshToken: boolean;
	sources: MicrosoftSourceStatus[];
};

@Injectable()
export class MicrosoftConnectionService {
	private readonly logger = new Logger(MicrosoftConnectionService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly tokens: MicrosoftTokenService,
		private readonly state: MicrosoftSyncStateService,
		private readonly stamp: ActivityStampService,
		private readonly leases: SyncLeaseService,
	) {}

	async status(userId: string): Promise<MicrosoftConnectionStatus> {
		await this.onConnected(userId);
		const [accounts, rows, hasRefreshToken, scopes] = await Promise.all([
			this.db.account.findMany({
				where: { userId },
				select: { providerId: true, scope: true },
			}),
			this.state.listForUser(userId),
			this.tokens.hasRefreshToken(userId),
			this.tokens.grantedScopes(userId),
		]);
		const linked = accounts.some(
			(account) => account.providerId === MICROSOFT_PROVIDER_ID,
		);
		const source = (
			resource: SyncResource,
			name: "mail" | "calendar",
		): MicrosoftSourceStatus => {
			const matching = rows.filter((row) => row.resource === resource);
			const last = matching
				.flatMap((row) => (row.lastSyncedAt ? [row.lastSyncedAt] : []))
				.toSorted((a, b) => b.getTime() - a.getTime())[0];
			const failed =
				matching.find(
					(row) => row.syncStatus === MailboxSyncStatus.NEEDS_RECONNECT,
				) ??
				matching.find((row) => row.syncStatus === MailboxSyncStatus.FAILED);
			return {
				source: name,
				connected: scopes.includes(MICROSOFT_RESOURCE_SCOPES[name]),
				status: failed?.syncStatus ?? matching[0]?.syncStatus ?? null,
				lastSyncedAt: last?.toISOString() ?? null,
				lastError: failed?.lastError ?? null,
				autoCreate: matching.some((row) => row.autoCreate),
			};
		};
		return {
			configured: isMicrosoftConfigured(),
			linked,
			required: signsInWithMicrosoft(accounts),
			hasRefreshToken,
			sources: [
				source(SyncResource.MAIL, "mail"),
				source(SyncResource.CALENDAR, "calendar"),
			],
		};
	}

	async onConnected(userId: string): Promise<void> {
		const account = await this.db.account.findFirst({
			where: { userId, providerId: MICROSOFT_PROVIDER_ID },
			select: { scope: true, refreshToken: true, updatedAt: true },
		});
		if (!account || !hasMicrosoftGraphScopes(account.scope)) return;
		if (account.refreshToken)
			await this.state.restoreConnected(userId, account.updatedAt);
		await this.state.ensureForUser(userId);
	}

	async reconcileAll(): Promise<void> {
		const accounts = await this.db.account.findMany({
			where: { providerId: MICROSOFT_PROVIDER_ID },
			select: { userId: true, scope: true },
		});
		for (const account of accounts) {
			if (hasMicrosoftGraphScopes(account.scope))
				await this.state.ensureForUser(account.userId);
		}
	}

	async purgeSyncedData(userId: string): Promise<{ purged: number }> {
		const owner = await this.exclusiveOwner(userId, "purge");
		try {
			const [threads, events] = await this.leases.withUserExclusive(
				userId,
				SyncProvider.MICROSOFT,
				owner,
				async (tx) => {
					const deletedThreads = await tx.emailThread.deleteMany({
						where: {
							messages: {
								some: {
									syncedByUserId: userId,
									provider: SyncProvider.MICROSOFT,
								},
							},
						},
					});
					const deletedEvents = await tx.calendarEvent.deleteMany({
						where: {
							syncedByUserId: userId,
							provider: SyncProvider.MICROSOFT,
						},
					});
					await this.stamp.recomputeAll(tx);
					return [deletedThreads, deletedEvents] as const;
				},
			);
			const purged = threads.count + events.count;
			this.logger.log({
				message: "Microsoft synced data purged",
				userId,
				purged,
			});
			return { purged };
		} finally {
			await this.leases.releaseUser(userId, SyncProvider.MICROSOFT, owner);
		}
	}

	async disconnect(userId: string): Promise<{ disconnected: boolean }> {
		const owner = await this.exclusiveOwner(userId, "disconnect");
		try {
			await this.leases.withUserExclusive(
				userId,
				SyncProvider.MICROSOFT,
				owner,
				async (tx) => {
					await this.tokens.disconnectDataAccess(userId);
					await this.state.removeOwned(userId, owner, tx);
				},
			);
			this.logger.log({
				message: "Microsoft data access disconnected locally",
				userId,
			});
			return { disconnected: true };
		} finally {
			await this.leases.releaseUser(userId, SyncProvider.MICROSOFT, owner);
		}
	}

	private async exclusiveOwner(
		userId: string,
		action: "purge" | "disconnect",
	): Promise<string> {
		const owner = `microsoft-${action}:${randomUUID()}`;
		const lease = await this.leases.claimUserExclusive({
			userId,
			provider: SyncProvider.MICROSOFT,
			owner,
			now: new Date(),
			leaseMs: 2 * 60_000,
		});
		if (!lease.acquired)
			throw new ConflictException(
				"Microsoft sync is active. Wait for it to finish and try again.",
			);
		return owner;
	}

	async setAutoCreate(
		userId: string,
		source: "mail" | "calendar",
		enabled: boolean,
	): Promise<void> {
		const resource =
			source === "mail" ? SyncResource.MAIL : SyncResource.CALENDAR;
		const rows = await this.state.listForUser(userId);
		if (!rows.some((row) => row.resource === resource)) {
			throw new NotFoundException(`${source} is not connected.`);
		}
		await this.state.setAutoCreate(userId, resource, enabled);
	}
}
