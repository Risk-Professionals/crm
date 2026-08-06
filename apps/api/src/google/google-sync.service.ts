import { Injectable, Logger } from "@nestjs/common";
import { CalendarSyncService } from "./calendar-sync.service";
import { GmailSyncService } from "./gmail-sync.service";
import { isSyncSource } from "./google.constants";
import { GoogleConnectionService } from "./google-connection.service";
import { SyncStateService } from "./sync-state.service";

const TICK_BUDGET_MS = 60_000;

export type TickSummary = {
	attempted: number;
	synced: number;
	skipped: number;
	failed: number;
	durationMs: number;
};

@Injectable()
export class GoogleSyncService {
	private readonly logger = new Logger(GoogleSyncService.name);

	constructor(
		private readonly state: SyncStateService,
		private readonly calendar: CalendarSyncService,
		private readonly gmail: GmailSyncService,
		private readonly connections: GoogleConnectionService,
	) {}

	async runDue(): Promise<TickSummary> {
		const startedAt = Date.now();
		const summary: TickSummary = {
			attempted: 0,
			synced: 0,
			skipped: 0,
			failed: 0,
			durationMs: 0,
		};

		await this.connections.reconcileAll();

		const due = await this.state.due(new Date());

		for (const row of due) {
			if (Date.now() - startedAt > TICK_BUDGET_MS) {
				this.logger.log({
					message: "Sync tick budget reached",
					remaining: due.length - summary.attempted,
				});
				break;
			}

			summary.attempted += 1;

			try {
				if (!isSyncSource(row.source)) {
					await this.state.markFailed(
						row.id,
						`Unsupported Google sync source: ${row.source}`,
					);
					summary.failed += 1;
					continue;
				}

				const outcome = await this.runOne(row.userId, row.source);

				if (outcome === null || outcome.status === "skipped") {
					summary.skipped += 1;
				} else if (
					outcome.status === "failed" ||
					outcome.status === "reconnect"
				) {
					summary.failed += 1;
				} else {
					summary.synced += 1;
				}
			} catch (error) {
				summary.failed += 1;
				await this.state.markFailed(
					row.id,
					error instanceof Error ? error.message : String(error),
				);
				this.logger.error(
					{
						message: "Sync threw",
						userId: row.userId,
						source: row.source,
					},
					error instanceof Error ? error.stack : String(error),
				);
			}
		}

		summary.durationMs = Date.now() - startedAt;

		this.logger.log({
			message: "Google sync tick",
			attempted: summary.attempted,
			synced: summary.synced,
			skipped: summary.skipped,
			failed: summary.failed,
			durationMs: summary.durationMs,
		});

		return summary;
	}

	async runOne(userId: string, source: string) {
		if (!isSyncSource(source)) {
			throw new Error(`Unsupported Google sync source: ${source}`);
		}

		const row = await this.state.get(userId, source);
		if (!row) return null;

		switch (source) {
			case "calendar":
				return this.calendar.sync(row);
			case "gmail":
				return this.gmail.sync(row);
		}
	}

	async runForUser(userId: string): Promise<void> {
		for (const source of ["calendar", "gmail"] as const) {
			await this.runOne(userId, source);
		}
	}
}
