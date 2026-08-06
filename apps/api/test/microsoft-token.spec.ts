import { describe, expect, it } from "bun:test";
import type { Db } from "@crm/db";
import {
	MicrosoftTokenService,
	parseProviderScopes,
} from "../src/microsoft/microsoft-token.service";

function database(scope: string | null, refreshToken = "refresh-token") {
	const seen: { update?: unknown } = {};
	const db = {
		account: {
			findFirst: async ({ select }: { select: Record<string, boolean> }) =>
				"scope" in select ? { scope } : { refreshToken },
			updateMany: async (args: unknown) => {
				seen.update = args;
				return { count: 1 };
			},
		},
	} as unknown as Db;

	return { db, seen };
}

class TestMicrosoftTokenService extends MicrosoftTokenService {
	constructor(
		db: Db,
		private readonly result: () => Promise<{ accessToken?: string | null }>,
	) {
		super(db);
	}

	protected override requestAccessToken() {
		return this.result();
	}
}

describe("MicrosoftTokenService", () => {
	it("parses both Better Auth and OAuth scope formats", () => {
		expect(
			parseProviderScopes("openid,profile Mail.Read Calendars.Read"),
		).toEqual(["openid", "profile", "Mail.Read", "Calendars.Read"]);
	});

	it("does not request a token before the resource scope is granted", async () => {
		const { db } = database("openid profile");
		let requested = false;
		const tokens = new TestMicrosoftTokenService(db, async () => {
			requested = true;
			return { accessToken: "token" };
		});

		expect(await tokens.accessTokenFor("user-1", "mail")).toEqual({
			outcome: "not-connected",
			reason: "The Mail.Read scope has not been granted.",
		});
		expect(requested).toBe(false);
	});

	it("uses Better Auth to return a valid access token", async () => {
		const { db } = database("openid Mail.Read");
		const tokens = new TestMicrosoftTokenService(db, async () => ({
			accessToken: "access-token",
		}));

		expect(await tokens.accessTokenFor("user-1", "mail")).toEqual({
			outcome: "ok",
			accessToken: "access-token",
		});
	});

	it("clears data-access tokens after an invalid grant", async () => {
		const { db, seen } = database("Calendars.Read");
		const tokens = new TestMicrosoftTokenService(db, async () => {
			throw new Error("invalid_grant");
		});

		expect(await tokens.accessTokenFor("user-1", "calendar")).toEqual({
			outcome: "needs-reconnect",
			reason: "Microsoft would not refresh the access token.",
		});
		expect(seen.update).toBeDefined();
	});

	it("preserves tokens after a transient refresh failure", async () => {
		const { db, seen } = database("Calendars.Read");
		const tokens = new TestMicrosoftTokenService(db, async () => {
			throw new Error("upstream timeout");
		});

		expect(await tokens.accessTokenFor("user-1", "calendar")).toEqual({
			outcome: "failed",
			reason: "Microsoft token refresh is temporarily unavailable.",
			retryable: true,
		});
		expect(seen.update).toBeUndefined();
	});

	it("clears data-access tokens without deleting the sign-in account", async () => {
		const { db, seen } = database("Mail.Read");
		const tokens = new TestMicrosoftTokenService(db, async () => ({}));

		await tokens.disconnectDataAccess("user-1");

		expect(seen.update).toEqual({
			where: { userId: "user-1", providerId: "microsoft" },
			data: {
				accessToken: null,
				refreshToken: null,
				idToken: null,
				scope: null,
				accessTokenExpiresAt: null,
				refreshTokenExpiresAt: null,
			},
		});
	});
});
