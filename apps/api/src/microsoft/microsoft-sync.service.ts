import { randomUUID } from "node:crypto";
import {
	type MailboxSyncModel as MailboxSync,
	SyncProvider,
	SyncResource,
} from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { SyncLeaseService } from "../sync/sync-lease.service";
import { MicrosoftCalendarSyncService } from "./calendar-sync.service";
import { MicrosoftMailSyncService } from "./mail-sync.service";
import { MicrosoftConnectionService } from "./microsoft-connection.service";
import {
	MicrosoftSyncStateService,
	SyncLeaseLostError,
} from "./microsoft-sync-state.service";

const RUN_BUDGET_MS = 60_000;
const LEASE_MS = 2 * 60_000;

export type MicrosoftTickSummary = {
	attempted: number;
	synced: number;
	skipped: number;
	failed: number;
	durationMs: number;
};

@Injectable()
export class MicrosoftSyncService {
	private readonly logger = new Logger(MicrosoftSyncService.name);

	constructor(
		private readonly leases: SyncLeaseService,
		private readonly mail: MicrosoftMailSyncService,
		private readonly calendar: MicrosoftCalendarSyncService,
		private readonly connections: MicrosoftConnectionService,
		private readonly state: MicrosoftSyncStateService,
	) {}

	async runDue(): Promise<MicrosoftTickSummary> {
		await this.connections.reconcileAll();
		return this.runClaims();
	}

	async runForUser(userId: string): Promise<MicrosoftTickSummary> {
		await this.connections.onConnected(userId);
		await this.state.retryFailedForUser(userId);
		return this.runClaims(userId);
	}

	private async runClaims(userId?: string): Promise<MicrosoftTickSummary> {
		const startedAt = Date.now();
		const owner = `microsoft-sync:${randomUUID()}`;
		const now = new Date();
		const mail = await this.leases.claimDue({
			provider: SyncProvider.MICROSOFT,
			resource: SyncResource.MAIL,
			owner,
			now,
			leaseMs: LEASE_MS,
			limit: 2,
			userId,
		});
		const calendar = await this.leases.claimDue({
			provider: SyncProvider.MICROSOFT,
			resource: SyncResource.CALENDAR,
			owner,
			now,
			leaseMs: LEASE_MS,
			limit: 1,
			userId,
		});
		const rows = [...mail, ...calendar].toSorted((left, right) => {
			if (left.folderId === "sentitems") return -1;
			if (right.folderId === "sentitems") return 1;
			return 0;
		});
		const summary: MicrosoftTickSummary = {
			attempted: 0,
			synced: 0,
			skipped: 0,
			failed: 0,
			durationMs: 0,
		};

		for (const row of rows) {
			if (Date.now() - startedAt >= RUN_BUDGET_MS) break;
			summary.attempted += 1;
			try {
				const outcome = await this.runOne(row, owner);
				if (outcome.status === "skipped") summary.skipped += 1;
				else if (outcome.status === "failed" || outcome.status === "reconnect")
					summary.failed += 1;
				else summary.synced += 1;
			} catch (error) {
				if (error instanceof SyncLeaseLostError) {
					summary.skipped += 1;
					this.logger.warn({
						message: "Microsoft sync stopped after losing its lease",
						userId: row.userId,
						resource: row.resource,
					});
				} else {
					summary.failed += 1;
					await this.state.markFailed(
						row.id,
						error instanceof Error ? error.message : String(error),
						owner,
					);
					this.logger.error(
						{
							message: "Microsoft sync threw",
							userId: row.userId,
							resource: row.resource,
						},
						error instanceof Error ? error.stack : String(error),
					);
				}
			} finally {
				await this.leases.release(row.id, owner);
			}
		}

		for (const row of rows.slice(summary.attempted))
			await this.leases.release(row.id, owner);
		summary.durationMs = Date.now() - startedAt;
		this.logger.log({ message: "Microsoft sync tick", ...summary });
		return summary;
	}

	private runOne(row: MailboxSync, owner: string) {
		if (row.resource === SyncResource.MAIL) return this.mail.sync(row, owner);
		if (row.resource === SyncResource.CALENDAR)
			return this.calendar.sync(row, owner);
		throw new Error(`Unsupported Microsoft sync resource: ${row.resource}`);
	}
}
