import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db, type MailboxSyncModel, SyncProvider, SyncResource } from "@crm/db";
import type { AgentTriggerService } from "../src/agent/agent-trigger.service";
import type { ActivityStampService } from "../src/crm/activity-stamp.service";
import type { GoogleMatchService } from "../src/google/google-match.service";
import type { MicrosoftCalendarClient } from "../src/microsoft/calendar.client";
import { MicrosoftCalendarSyncService } from "../src/microsoft/calendar-sync.service";
import { MicrosoftSyncStateService } from "../src/microsoft/microsoft-sync-state.service";
import type { MicrosoftTokenService } from "../src/microsoft/microsoft-token.service";

const suffix = crypto.randomUUID();
const userId = `microsoft-calendar-persistence-${suffix}`;
let companyId = "";
const leaseOwner = `microsoft-calendar-test:${suffix}`;

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
			name: "Microsoft Calendar Persistence",
			email: `${suffix}@example.com`,
			emailVerified: true,
		},
	});
	companyId = (
		await db.company.create({ data: { name: `Calendar ${suffix}` } })
	).id;
});

afterAll(async () => {
	await db.company.deleteMany({ where: { id: companyId } });
	await db.mailboxSync.deleteMany({ where: { userId } });
	await db.user.deleteMany({ where: { id: userId } });
});

describe("Microsoft calendar delta persistence", () => {
	it("persists one occurrence and exact attendees, then applies a tombstone", async () => {
		const state = new MicrosoftSyncStateService(db);
		await state.ensureForUser(userId);
		let row = await db.mailboxSync.findFirstOrThrow({
			where: {
				userId,
				provider: SyncProvider.MICROSOFT,
				resource: SyncResource.CALENDAR,
			},
		});
		let removed = false;
		const calendar = {
			delta: () =>
				Promise.resolve({
					outcome: "ok" as const,
					data: {
						value: removed
							? [{ id: "event-1", "@removed": { reason: "deleted" } }]
							: [
									{
										id: "event-1",
										iCalUId: "ical-1",
										seriesMasterId: "series-1",
										subject: "Risk review",
										start: {
											dateTime: "2026-08-10T09:00:00.0000000",
											timeZone: "UTC",
										},
										end: {
											dateTime: "2026-08-10T10:00:00.0000000",
											timeZone: "UTC",
										},
										organizer: {
											emailAddress: {
												address: "organizer@client.example",
												name: "Organizer",
											},
										},
										attendees: [
											{
												emailAddress: {
													address: "guest@client.example",
													name: "Guest",
												},
												status: { response: "accepted" },
											},
										],
										webLink: "https://outlook.office.com/calendar/item/event-1",
									},
								],
						"@odata.deltaLink": removed
							? "https://graph.microsoft.com/delta/calendar-2"
							: "https://graph.microsoft.com/delta/calendar-1",
					},
				}),
		};
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
		const service = new MicrosoftCalendarSyncService(
			db,
			calendar as unknown as MicrosoftCalendarClient,
			{
				accessTokenFor: () =>
					Promise.resolve({ outcome: "ok" as const, accessToken: "token" }),
			} as unknown as MicrosoftTokenService,
			match as unknown as GoogleMatchService,
			state,
			{
				touch: () => Promise.resolve(),
				recomputeAll: () => Promise.resolve(),
			} as unknown as ActivityStampService,
			{
				meetingSoon: () => Promise.resolve(),
			} as unknown as AgentTriggerService,
		);

		expect((await service.sync(await leased(row))).written).toBe(1);
		const event = await db.calendarEvent.findFirstOrThrow({
			where: { syncedByUserId: userId, providerEventId: "event-1" },
			include: { attendees: { orderBy: { email: "asc" } } },
		});
		expect(event.recurringEventId).toBe("series-1");
		expect(event.providerWebUrl).toContain("outlook.office.com");
		expect(
			event.attendees.map((attendee) => [attendee.email, attendee.isOrganizer]),
		).toEqual([
			["guest@client.example", false],
			["organizer@client.example", true],
		]);

		const movedService = new MicrosoftCalendarSyncService(
			db,
			{
				delta: () =>
					Promise.resolve({
						outcome: "ok" as const,
						data: {
							value: [
								{
									id: "event-1",
									iCalUId: "ical-1",
									seriesMasterId: "series-1",
									originalStart: "2026-08-10T09:00:00.0000000",
									subject: "Risk review moved",
									start: { dateTime: "2026-08-11T11:00:00.0000000" },
									end: { dateTime: "2026-08-11T12:00:00.0000000" },
									organizer: {
										emailAddress: { address: "organizer@client.example" },
									},
								},
							],
							"@odata.deltaLink":
								"https://graph.microsoft.com/delta/calendar-moved",
						},
					}),
			} as unknown as MicrosoftCalendarClient,
			{
				accessTokenFor: () =>
					Promise.resolve({ outcome: "ok" as const, accessToken: "token" }),
			} as unknown as MicrosoftTokenService,
			match as unknown as GoogleMatchService,
			state,
			{
				touch: () => Promise.resolve(),
				recomputeAll: () => Promise.resolve(),
			} as unknown as ActivityStampService,
			{
				meetingSoon: () => Promise.resolve(),
			} as unknown as AgentTriggerService,
		);
		row = await db.mailboxSync.findUniqueOrThrow({ where: { id: row.id } });
		expect((await movedService.sync(await leased(row))).written).toBe(1);
		const moved = await db.calendarEvent.findUniqueOrThrow({
			where: { id: event.id },
		});
		expect(moved.originalStartTime.toISOString()).toBe(
			event.originalStartTime.toISOString(),
		);
		expect(moved.startsAt.toISOString()).toBe("2026-08-11T11:00:00.000Z");

		removed = true;
		row = await db.mailboxSync.findUniqueOrThrow({ where: { id: row.id } });
		expect((await service.sync(await leased(row))).removed).toBe(1);
		expect(await db.calendarEvent.count({ where: { id: event.id } })).toBe(0);
	});
});
