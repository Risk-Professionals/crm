import { describe, expect, it } from "bun:test";
import { type MailboxSyncModel, SyncResource } from "@crm/db";
import type { MicrosoftCalendarSyncService } from "../src/microsoft/calendar-sync.service";
import type { MicrosoftMailSyncService } from "../src/microsoft/mail-sync.service";
import type { MicrosoftConnectionService } from "../src/microsoft/microsoft-connection.service";
import { MicrosoftSyncService } from "../src/microsoft/microsoft-sync.service";
import type { MicrosoftSyncStateService } from "../src/microsoft/microsoft-sync-state.service";
import { SyncRouter } from "../src/sync/sync.router";
import type { SyncLeaseService } from "../src/sync/sync-lease.service";
import type { AuthedTrpcContext } from "../src/trpc/context.types";

const row = (id: string, folderId: string): MailboxSyncModel =>
	({
		id,
		userId: "user-1",
		resource: SyncResource.MAIL,
		folderId,
		leaseOwner: "owner",
	}) as MailboxSyncModel;

describe("MicrosoftSyncService", () => {
	it("makes syncNow fail when the run summary contains failures", async () => {
		const router = new SyncRouter(
			{} as MicrosoftConnectionService,
			{
				runForUser: () =>
					Promise.resolve({
						attempted: 1,
						synced: 0,
						skipped: 0,
						failed: 1,
						durationMs: 1,
					}),
			} as unknown as MicrosoftSyncService,
			{} as never,
		);

		expect(
			router.syncNow({ user: { id: "user-1" } } as AuthedTrpcContext),
		).rejects.toThrow("Microsoft sync failed for 1 source.");
	});

	it("processes Sent Items before Inbox within one bounded claim", async () => {
		const calls: string[] = [];
		const service = new MicrosoftSyncService(
			{
				claimDue: ({ resource }: { resource: SyncResource }) =>
					Promise.resolve(
						resource === SyncResource.MAIL
							? [row("inbox", "inbox"), row("sent", "sentitems")]
							: [],
					),
				release: () => Promise.resolve(true),
			} as unknown as SyncLeaseService,
			{
				sync: (sync: MailboxSyncModel) => {
					calls.push(sync.folderId ?? "");
					return Promise.resolve({
						resource: "mail" as const,
						userId: sync.userId,
						status: "synced" as const,
					});
				},
			} as unknown as MicrosoftMailSyncService,
			{} as MicrosoftCalendarSyncService,
			{ reconcileAll: () => Promise.resolve() } as MicrosoftConnectionService,
			{
				retryFailedForUser: () => Promise.resolve(),
			} as unknown as MicrosoftSyncStateService,
		);

		await service.runDue();
		expect(calls).toEqual(["sentitems", "inbox"]);
	});
});
