import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db, type MailboxSyncModel, SyncProvider, SyncResource } from "@crm/db";
import type { ActivityStampService } from "../src/crm/activity-stamp.service";
import type { GoogleMatchService } from "../src/google/google-match.service";
import type { MicrosoftMailClient } from "../src/microsoft/mail.client";
import { MicrosoftMailSyncService } from "../src/microsoft/mail-sync.service";
import { MicrosoftSyncStateService } from "../src/microsoft/microsoft-sync-state.service";
import type { MicrosoftTokenService } from "../src/microsoft/microsoft-token.service";

const suffix = crypto.randomUUID();
const userId = `microsoft-mail-persistence-${suffix}`;
let companyId = "";
const leaseOwner = `microsoft-mail-test:${suffix}`;

async function leased(row: MailboxSyncModel): Promise<MailboxSyncModel> {
	return db.mailboxSync.update({
		where: { id: row.id },
		data: {
			leaseOwner,
			leaseExpiresAt: new Date(Date.now() + 60_000),
		},
	});
}

beforeAll(async () => {
	await db.user.create({
		data: {
			id: userId,
			name: "Microsoft Mail Persistence",
			email: `${suffix}@example.com`,
			emailVerified: true,
		},
	});
	companyId = (await db.company.create({ data: { name: `Mail ${suffix}` } }))
		.id;
});

afterAll(async () => {
	await db.company.deleteMany({ where: { id: companyId } });
	await db.mailboxSync.deleteMany({ where: { userId } });
	await db.user.deleteMany({ where: { id: userId } });
});

describe("Microsoft mail delta persistence", () => {
	it("imports a new message that arrives while the historical baseline is paging", async () => {
		const state = new MicrosoftSyncStateService(db);
		await state.ensureForUser(userId);
		const row = await db.mailboxSync.findFirstOrThrow({
			where: {
				userId,
				provider: SyncProvider.MICROSOFT,
				resource: SyncResource.MAIL,
				folderId: "inbox",
			},
		});
		const requested: Array<string | null | undefined> = [];
		const message = (id: string, sentAt: Date) => ({
			id,
			conversationId: `baseline-${id}`,
			from: {
				emailAddress: { address: "buyer@client.example", name: "Buyer" },
			},
			toRecipients: [
				{
					emailAddress: { address: `${suffix}@example.com`, name: "CRM User" },
				},
			],
			subject: id,
			body: { contentType: "text", content: id },
			sentDateTime: sentAt.toISOString(),
		});
		const boundary = row.ingestAfter ?? new Date();
		const mail = {
			delta: (_token: string, options: { cursor?: string | null }) => {
				requested.push(options.cursor);
				return options.cursor === "https://graph.microsoft.com/next/1"
					? Promise.resolve({
							outcome: "ok" as const,
							data: {
								value: [
									message(
										"arrived-during-baseline",
										new Date(boundary.getTime() + 1),
									),
								],
								"@odata.deltaLink": "https://graph.microsoft.com/delta/final",
							},
						})
					: Promise.resolve({
							outcome: "ok" as const,
							data: {
								value: [
									message("historic-1", new Date(boundary.getTime() - 1)),
								],
								"@odata.nextLink": "https://graph.microsoft.com/next/1",
							},
						});
			},
		};
		const service = new MicrosoftMailSyncService(
			mail as unknown as MicrosoftMailClient,
			{
				accessTokenFor: () =>
					Promise.resolve({ outcome: "ok" as const, accessToken: "token" }),
			} as unknown as MicrosoftTokenService,
			{
				internalIdentity: () =>
					Promise.resolve({
						addresses: new Set([`${suffix}@example.com`]),
						domains: new Set(["example.com"]),
					}),
				suppressedDomains: () => Promise.resolve(new Set<string>()),
				suppressedEmails: () => Promise.resolve(new Set<string>()),
				resolve: () => Promise.resolve({ companyId, contactId: null }),
			} as unknown as GoogleMatchService,
			state,
			{
				touch: () => Promise.resolve(),
				recomputeAll: () => Promise.resolve(),
			} as unknown as ActivityStampService,
		);

		const outcome = await service.sync(await leased(row));
		expect(outcome.status).toBe("synced");
		expect(requested).toEqual([null, "https://graph.microsoft.com/next/1"]);
		expect(
			await db.emailMessage.count({ where: { syncedByUserId: userId } }),
		).toBe(1);
		expect(
			await db.emailMessage.count({
				where: { syncedByUserId: userId, providerMessageId: "historic-1" },
			}),
		).toBe(0);
		const saved = await db.mailboxSync.findUniqueOrThrow({
			where: { id: row.id },
		});
		expect(saved.providerPageCursor).toBeNull();
		expect(saved.providerCursor).toBe(
			"https://graph.microsoft.com/delta/final",
		);
		expect(saved.lastSyncedAt).not.toBeNull();
	});

	it("marks an expired cursor as a reconciliation generation", async () => {
		const state = new MicrosoftSyncStateService(db);
		const row = await db.mailboxSync.findFirstOrThrow({
			where: {
				userId,
				provider: SyncProvider.MICROSOFT,
				resource: SyncResource.MAIL,
				folderId: "sentitems",
			},
		});
		await db.mailboxSync.update({
			where: { id: row.id },
			data: {
				providerCursor: "https://graph.microsoft.com/delta/expired",
				providerPageCursor: "https://graph.microsoft.com/next/expired",
				lastSyncedAt: new Date(),
			},
		});
		const service = new MicrosoftMailSyncService(
			{
				delta: () =>
					Promise.resolve({
						outcome: "cursor-invalid" as const,
						reason: "Gone",
					}),
			} as unknown as MicrosoftMailClient,
			{
				accessTokenFor: () =>
					Promise.resolve({ outcome: "ok" as const, accessToken: "token" }),
			} as unknown as MicrosoftTokenService,
			{} as GoogleMatchService,
			state,
			{ recomputeAll: () => Promise.resolve() } as ActivityStampService,
		);

		const current = await db.mailboxSync.findUniqueOrThrow({
			where: { id: row.id },
		});
		expect((await service.sync(await leased(current))).status).toBe("synced");
		const saved = await db.mailboxSync.findUniqueOrThrow({
			where: { id: row.id },
		});
		expect(saved.providerCursor).toBeNull();
		expect(saved.providerPageCursor).toBeNull();
		expect(saved.reconciliationStartedAt).not.toBeNull();
	});

	it("reconciles after 410 without importing mail older than the ingest boundary", async () => {
		const state = new MicrosoftSyncStateService(db);
		const boundary = new Date();
		const row = await db.mailboxSync.findFirstOrThrow({
			where: {
				userId,
				provider: SyncProvider.MICROSOFT,
				resource: SyncResource.MAIL,
				folderId: "sentitems",
			},
		});
		await db.mailboxSync.update({
			where: { id: row.id },
			data: {
				ingestAfter: boundary,
				providerCursor: null,
				providerPageCursor: null,
				reconciliationStartedAt: new Date(),
				lastSyncedAt: new Date(),
			},
		});
		const message = (id: string, sentAt: Date) => ({
			id,
			conversationId: `conversation-${id}`,
			from: {
				emailAddress: { address: "buyer@client.example", name: "Buyer" },
			},
			toRecipients: [
				{
					emailAddress: { address: `${suffix}@example.com`, name: "CRM User" },
				},
			],
			subject: id,
			body: { contentType: "text", content: id },
			sentDateTime: sentAt.toISOString(),
		});
		const service = new MicrosoftMailSyncService(
			{
				delta: () =>
					Promise.resolve({
						outcome: "ok" as const,
						data: {
							value: [
								message(
									"historic-after-410",
									new Date(boundary.getTime() - 86_400_000),
								),
								message("new-after-410", new Date(boundary.getTime() + 60_000)),
							],
							"@odata.deltaLink":
								"https://graph.microsoft.com/delta/reconciled",
						},
					}),
			} as unknown as MicrosoftMailClient,
			{
				accessTokenFor: () =>
					Promise.resolve({ outcome: "ok" as const, accessToken: "token" }),
			} as unknown as MicrosoftTokenService,
			{
				internalIdentity: () =>
					Promise.resolve({
						addresses: new Set([`${suffix}@example.com`]),
						domains: new Set(["example.com"]),
					}),
				suppressedDomains: () => Promise.resolve(new Set<string>()),
				suppressedEmails: () => Promise.resolve(new Set<string>()),
				resolve: () => Promise.resolve({ companyId, contactId: null }),
			} as unknown as GoogleMatchService,
			state,
			{
				touch: () => Promise.resolve(),
				recomputeAll: () => Promise.resolve(),
			} as unknown as ActivityStampService,
		);

		const current = await db.mailboxSync.findUniqueOrThrow({
			where: { id: row.id },
		});
		expect((await service.sync(await leased(current))).written).toBe(1);
		expect(
			await db.emailMessage.count({
				where: {
					syncedByUserId: userId,
					providerMessageId: "historic-after-410",
				},
			}),
		).toBe(0);
		expect(
			await db.emailMessage.count({
				where: { syncedByUserId: userId, providerMessageId: "new-after-410" },
			}),
		).toBe(1);
	});

	it("keeps a moved immutable message when the old folder later emits a tombstone", async () => {
		const state = new MicrosoftSyncStateService(db);
		await db.mailboxSync.updateMany({
			where: { userId, provider: SyncProvider.MICROSOFT },
			data: { ingestAfter: new Date("2026-08-05T00:00:00.000Z") },
		});
		const match = {
			internalIdentity: () =>
				Promise.resolve({
					addresses: new Set([`${suffix}@example.com`]),
					domains: new Set(["example.com"]),
				}),
			suppressedDomains: () => Promise.resolve(new Set<string>()),
			suppressedEmails: () => Promise.resolve(new Set<string>()),
			resolve: () => Promise.resolve({ companyId, contactId: null }),
		};
		const stamp = {
			touch: () => Promise.resolve(),
			recomputeAll: () => Promise.resolve(),
		};
		const message = {
			id: "immutable-message-1",
			conversationId: "conversation-1",
			from: {
				emailAddress: { address: "buyer@client.example", name: "Buyer" },
			},
			toRecipients: [
				{
					emailAddress: { address: `${suffix}@example.com`, name: "CRM User" },
				},
			],
			subject: "Risk review",
			body: { contentType: "text", content: "Please review." },
			sentDateTime: "2026-08-06T10:00:00.000Z",
			webLink: "https://outlook.office.com/mail/item/immutable-message-1",
		};
		const run = async (
			row: Awaited<ReturnType<typeof db.mailboxSync.findFirstOrThrow>>,
			value: object,
			delta: string,
		) => {
			const service = new MicrosoftMailSyncService(
				{
					delta: () =>
						Promise.resolve({
							outcome: "ok" as const,
							data: { value: [value], "@odata.deltaLink": delta },
						}),
				} as unknown as MicrosoftMailClient,
				{
					accessTokenFor: () =>
						Promise.resolve({ outcome: "ok" as const, accessToken: "token" }),
				} as unknown as MicrosoftTokenService,
				match as unknown as GoogleMatchService,
				state,
				stamp as unknown as ActivityStampService,
			);
			return service.sync(await leased(row));
		};

		let sent = await db.mailboxSync.findFirstOrThrow({
			where: {
				userId,
				folderId: "sentitems",
				provider: SyncProvider.MICROSOFT,
			},
		});
		expect(
			(await run(sent, message, "https://graph.microsoft.com/delta/sent-1"))
				.written,
		).toBe(1);
		let stored = await db.emailMessage.findFirstOrThrow({
			where: { syncedByUserId: userId, providerMessageId: message.id },
		});
		expect(stored.providerFolderId).toBe("sentitems");

		let inbox = await db.mailboxSync.findFirstOrThrow({
			where: { userId, folderId: "inbox", provider: SyncProvider.MICROSOFT },
		});
		expect(
			(await run(inbox, message, "https://graph.microsoft.com/delta/inbox-2"))
				.written,
		).toBe(1);
		stored = await db.emailMessage.findUniqueOrThrow({
			where: { id: stored.id },
		});
		expect(stored.providerFolderId).toBe("inbox");

		sent = await db.mailboxSync.findUniqueOrThrow({ where: { id: sent.id } });
		expect(
			(
				await run(
					sent,
					{ id: message.id, "@removed": { reason: "changed" } },
					"https://graph.microsoft.com/delta/sent-2",
				)
			).removed,
		).toBe(0);
		expect(await db.emailMessage.count({ where: { id: stored.id } })).toBe(1);

		inbox = await db.mailboxSync.findUniqueOrThrow({ where: { id: inbox.id } });
		const tombstone = { id: message.id, "@removed": { reason: "deleted" } };
		expect(
			(await run(inbox, tombstone, "https://graph.microsoft.com/delta/inbox-3"))
				.removed,
		).toBe(1);
		inbox = await db.mailboxSync.findUniqueOrThrow({ where: { id: inbox.id } });
		expect(
			(await run(inbox, tombstone, "https://graph.microsoft.com/delta/inbox-4"))
				.removed,
		).toBe(0);
		expect(await db.emailMessage.count({ where: { id: stored.id } })).toBe(0);
		expect(
			await db.emailThread.count({
				where: {
					providerUserId: userId,
					providerThreadId: message.conversationId,
				},
			}),
		).toBe(0);
	});
});
