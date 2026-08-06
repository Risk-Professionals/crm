import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	db,
	GoogleSyncStatus,
	MailboxSyncStatus,
	SyncProvider,
	SyncResource,
} from "@crm/db";
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
});
