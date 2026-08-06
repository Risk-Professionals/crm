import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	db,
	GoogleSyncStatus,
	MailboxSyncStatus,
	SyncProvider,
	SyncResource,
} from "@crm/db";
import {
	MicrosoftSyncStateService,
	SyncLeaseLostError,
} from "../src/microsoft/microsoft-sync-state.service";
import { SyncLeaseService } from "../src/sync/sync-lease.service";

const suffix = crypto.randomUUID();
const userId = `sync-lease-${suffix}`;
const syncSource = `microsoft:mail:${suffix}`;

beforeAll(async () => {
	await db.user.create({
		data: {
			id: userId,
			name: "Sync Lease Test",
			email: `${suffix}@example.com`,
			emailVerified: true,
		},
	});
});

afterAll(async () => {
	await db.mailboxSync.deleteMany({ where: { userId } });
	await db.user.deleteMany({ where: { id: userId } });
});

describe("SyncLeaseService", () => {
	it("allows one concurrent claimant and recovers after lease expiry", async () => {
		await db.mailboxSync.create({
			data: {
				userId,
				source: syncSource,
				status: GoogleSyncStatus.IDLE,
				provider: SyncProvider.MICROSOFT,
				resource: SyncResource.MAIL,
				scopeKey: "folder:inbox",
				syncStatus: MailboxSyncStatus.IDLE,
				autoCreate: false,
			},
		});

		const leases = new SyncLeaseService(db);
		const now = new Date("2026-08-06T00:00:00.000Z");
		const [first, second] = await Promise.all([
			leases.claimDue({
				provider: SyncProvider.MICROSOFT,
				resource: SyncResource.MAIL,
				owner: "worker-a",
				now,
				leaseMs: 60_000,
				limit: 1,
			}),
			leases.claimDue({
				provider: SyncProvider.MICROSOFT,
				resource: SyncResource.MAIL,
				owner: "worker-b",
				now,
				leaseMs: 60_000,
				limit: 1,
			}),
		]);

		expect(first.length + second.length).toBe(1);
		const claimed = first[0] ?? second[0];
		expect(claimed?.leaseOwner).toBe(first.length ? "worker-a" : "worker-b");

		const reclaimed = await leases.claimDue({
			provider: SyncProvider.MICROSOFT,
			resource: SyncResource.MAIL,
			owner: "worker-c",
			now: new Date(now.getTime() + 60_001),
			leaseMs: 60_000,
			limit: 1,
		});

		expect(reclaimed).toHaveLength(1);
		expect(reclaimed[0]?.leaseOwner).toBe("worker-c");
		expect(await leases.release(reclaimed[0]?.id ?? "", "worker-c")).toBe(true);
	});

	it("keeps an exclusive claim waiting until a fenced business write commits", async () => {
		const row = await db.mailboxSync.findFirstOrThrow({ where: { userId } });
		const company = await db.company.create({
			data: { name: `Lease overlap ${suffix}` },
		});
		const now = new Date();
		await db.mailboxSync.update({
			where: { id: row.id },
			data: {
				leaseOwner: "worker-active",
				leaseExpiresAt: new Date(now.getTime() + 60_000),
			},
		});
		const state = new MicrosoftSyncStateService(db);
		const leases = new SyncLeaseService(db);
		const locked = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const write = state.withBusinessWrite(
			row.id,
			"worker-active",
			async (tx) => {
				await tx.company.update({
					where: { id: company.id },
					data: { name: "writer-held" },
				});
				locked.resolve();
				await release.promise;
			},
		);
		await locked.promise;
		let exclusiveSettled = false;
		const exclusive = leases
			.claimUserExclusive({
				userId,
				provider: SyncProvider.MICROSOFT,
				owner: "exclusive",
				now,
				leaseMs: 60_000,
			})
			.then((result) => {
				exclusiveSettled = true;
				return result;
			});
		await Bun.sleep(50);
		expect(exclusiveSettled).toBe(false);
		release.resolve();
		await write;
		expect((await exclusive).acquired).toBe(false);
		await db.company.delete({ where: { id: company.id } });
	});

	it("rejects an expired stale business writer after an exclusive replacement", async () => {
		const row = await db.mailboxSync.findFirstOrThrow({ where: { userId } });
		const company = await db.company.create({
			data: { name: `Stale writer ${suffix}` },
		});
		const now = new Date();
		await db.mailboxSync.update({
			where: { id: row.id },
			data: {
				leaseOwner: "worker-stale",
				leaseExpiresAt: new Date(now.getTime() - 1),
			},
		});
		const leases = new SyncLeaseService(db);
		const exclusive = await leases.claimUserExclusive({
			userId,
			provider: SyncProvider.MICROSOFT,
			owner: "exclusive-replacement",
			now,
			leaseMs: 60_000,
		});
		expect(exclusive.acquired).toBe(true);
		const state = new MicrosoftSyncStateService(db);
		expect(
			state.withBusinessWrite(row.id, "worker-stale", (tx) =>
				tx.company.update({
					where: { id: company.id },
					data: { name: "stale mutation" },
				}),
			),
		).rejects.toBeInstanceOf(SyncLeaseLostError);
		expect(
			(await db.company.findUniqueOrThrow({ where: { id: company.id } })).name,
		).toBe(`Stale writer ${suffix}`);
		await db.company.delete({ where: { id: company.id } });
		await leases.releaseUser(
			userId,
			SyncProvider.MICROSOFT,
			"exclusive-replacement",
		);
	});

	it("prevents an expired owner from regressing a replacement cursor", async () => {
		const row = await db.mailboxSync.findFirstOrThrow({ where: { userId } });
		const now = new Date();
		await db.mailboxSync.update({
			where: { id: row.id },
			data: {
				leaseOwner: "worker-new",
				leaseExpiresAt: new Date(now.getTime() + 60_000),
				providerCursor: "https://graph.microsoft.com/delta/new",
			},
		});
		const state = new MicrosoftSyncStateService(db);
		expect(
			state.commitPage(
				row.id,
				{ delta: "https://graph.microsoft.com/delta/stale" },
				"worker-old",
			),
		).rejects.toBeInstanceOf(SyncLeaseLostError);
		expect(
			(
				await db.mailboxSync.findUniqueOrThrow({
					where: { id: row.id },
				})
			).providerCursor,
		).toBe("https://graph.microsoft.com/delta/new");
	});

	it("clears reconnect state only after a later account update", async () => {
		const state = new MicrosoftSyncStateService(db);
		const row = await db.mailboxSync.findFirstOrThrow({ where: { userId } });
		await db.mailboxSync.update({
			where: { id: row.id },
			data: {
				status: GoogleSyncStatus.NEEDS_RECONNECT,
				syncStatus: MailboxSyncStatus.NEEDS_RECONNECT,
				leaseOwner: null,
				leaseExpiresAt: null,
			},
		});
		const reconnectRow = await db.mailboxSync.findUniqueOrThrow({
			where: { id: row.id },
		});
		await state.restoreConnected(
			userId,
			new Date(reconnectRow.updatedAt.getTime() - 1),
		);
		expect(
			(await db.mailboxSync.findUniqueOrThrow({ where: { id: row.id } }))
				.syncStatus,
		).toBe(MailboxSyncStatus.NEEDS_RECONNECT);
		await state.restoreConnected(
			userId,
			new Date(reconnectRow.updatedAt.getTime() + 1),
		);
		expect(
			(await db.mailboxSync.findUniqueOrThrow({ where: { id: row.id } }))
				.syncStatus,
		).toBe(MailboxSyncStatus.IDLE);
	});
});
