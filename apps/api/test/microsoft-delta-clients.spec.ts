import { describe, expect, it } from "bun:test";
import { MicrosoftCalendarClient } from "../src/microsoft/calendar.client";
import type {
	GraphClient,
	GraphRequestOptions,
} from "../src/microsoft/graph.client";
import { MicrosoftMailClient } from "../src/microsoft/mail.client";

function graph() {
	const calls: Array<{ url: string; options: GraphRequestOptions }> = [];
	const client = {
		get: async (url: string, _token: string, options: GraphRequestOptions) => {
			calls.push({ url, options });
			return { outcome: "ok", data: { value: [] } };
		},
	} as unknown as GraphClient;

	return { client, calls };
}

describe("Microsoft delta clients", () => {
	it("starts folder-scoped mail delta with immutable IDs", async () => {
		const { client, calls } = graph();
		const mail = new MicrosoftMailClient(client);

		await mail.delta("token", { folderId: "folder/id" });

		expect(calls[0]?.url).toBe(
			"https://graph.microsoft.com/v1.0/me/mailFolders/folder%2Fid/messages/delta",
		);
		expect(calls[0]?.options.prefer).toEqual([
			'IdType="ImmutableId"',
			'outlook.body-content-type="text"',
		]);
		expect(calls[0]?.options.params?.$select).toContain("conversationId");
	});

	it("follows an opaque mail link without changing its query", async () => {
		const { client, calls } = graph();
		const mail = new MicrosoftMailClient(client);
		const cursor =
			"https://graph.microsoft.com/v1.0/me/mailFolders/id/messages/delta?$skiptoken=opaque";

		await mail.delta("token", { folderId: "ignored", cursor });

		expect(calls[0]).toEqual({
			url: cursor,
			options: {
				prefer: ['IdType="ImmutableId"', 'outlook.body-content-type="text"'],
			},
		});
	});

	it("starts a fixed UTC calendar window and preserves it in the cursor", async () => {
		const { client, calls } = graph();
		const calendar = new MicrosoftCalendarClient(client);
		const windowStart = new Date("2026-08-06T00:00:00.000Z");
		const windowEnd = new Date("2027-02-02T00:00:00.000Z");

		await calendar.delta("token", { windowStart, windowEnd });

		expect(calls[0]).toEqual({
			url: "https://graph.microsoft.com/v1.0/me/calendarView/delta",
			options: {
				prefer: ['IdType="ImmutableId"', 'outlook.timezone="UTC"'],
				params: {
					startDateTime: windowStart.toISOString(),
					endDateTime: windowEnd.toISOString(),
				},
			},
		});

		const cursor =
			"https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=opaque";
		await calendar.delta("token", { windowStart, windowEnd, cursor });
		expect(calls[1]).toEqual({
			url: cursor,
			options: {
				prefer: ['IdType="ImmutableId"', 'outlook.timezone="UTC"'],
			},
		});
	});
});
