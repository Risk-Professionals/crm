import { describe, expect, it } from "bun:test";
import {
	type Db,
	GoogleSyncStatus,
	MailboxSyncStatus,
	SyncProvider,
	SyncResource,
} from "@crm/db";
import type { CalendarSyncService } from "../src/google/calendar-sync.service";
import type { GmailSyncService } from "../src/google/gmail-sync.service";
import type { GoogleConnectionService } from "../src/google/google-connection.service";
import { GoogleSyncService } from "../src/google/google-sync.service";
import { SyncStateService } from "../src/google/sync-state.service";

function stateDb() {
	const seen: { findMany?: unknown; upsert?: unknown } = {};
	const db = {
		mailboxSync: {
			findMany: async (args: unknown) => {
				seen.findMany = args;
				return [];
			},
			upsert: async (args: unknown) => {
				seen.upsert = args;
				return {};
			},
		},
	} as unknown as Db;

	return { state: new SyncStateService(db), seen };
}

describe("Google sync provider compatibility", () => {
	it("claims only legacy or explicitly Google mailbox rows", async () => {
		const { state, seen } = stateDb();

		await state.due(new Date("2026-08-06T00:00:00.000Z"));

		expect(seen.findMany).toMatchObject({
			where: {
				source: { in: ["calendar", "gmail"] },
				OR: [{ provider: SyncProvider.GOOGLE }, { provider: null }],
			},
		});
	});

	it("dual-writes provider-neutral state when Google connects", async () => {
		const { state, seen } = stateDb();

		await state.ensure("user-1", "gmail", { autoCreate: false });

		expect(seen.upsert).toMatchObject({
			create: {
				status: GoogleSyncStatus.IDLE,
				provider: SyncProvider.GOOGLE,
				resource: SyncResource.MAIL,
				scopeKey: "legacy:gmail",
				syncStatus: MailboxSyncStatus.IDLE,
			},
			update: {
				status: GoogleSyncStatus.IDLE,
				provider: SyncProvider.GOOGLE,
				resource: SyncResource.MAIL,
				scopeKey: "legacy:gmail",
				syncStatus: MailboxSyncStatus.IDLE,
			},
		});
	});

	it("refuses an unknown source instead of routing it to Gmail", async () => {
		const sync = new GoogleSyncService(
			{} as SyncStateService,
			{} as CalendarSyncService,
			{} as GmailSyncService,
			{} as GoogleConnectionService,
		);

		expect(sync.runOne("user-1", "microsoft-mail")).rejects.toThrow(
			"Unsupported Google sync source: microsoft-mail",
		);
	});
});
