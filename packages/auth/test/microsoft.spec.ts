import { describe, expect, it } from "bun:test";
import { APIError } from "better-auth/api";
import { microsoftProfileToUser } from "../src/microsoft";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";

describe("Microsoft identity mapping", () => {
	it("uses the tenant and object IDs as the stable provider identity", () => {
		expect(
			microsoftProfileToUser(
				{
					tid: TENANT_ID,
					oid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
					email: "Person@Example.com",
					sub: "pairwise-subject-that-may-change",
				},
				TENANT_ID,
			),
		).toEqual({
			id: `${TENANT_ID}:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
			email: "person@example.com",
			emailVerified: false,
		});
	});

	it("falls back to the managed account username when email is absent", () => {
		expect(
			microsoftProfileToUser(
				{
					tid: TENANT_ID,
					oid: "object-id",
					preferred_username: "person@example.com",
				},
				TENANT_ID,
			).email,
		).toBe("person@example.com");
	});

	it("refuses another tenant even when its email looks allowed", () => {
		expect(() =>
			microsoftProfileToUser(
				{
					tid: "99999999-2222-3333-4444-555555555555",
					oid: "object-id",
					email: "person@example.com",
				},
				TENANT_ID,
			),
		).toThrow(APIError);
	});

	it("refuses an account with no canonical email address", () => {
		expect(() =>
			microsoftProfileToUser(
				{ tid: TENANT_ID, oid: "object-id", preferred_username: "person" },
				TENANT_ID,
			),
		).toThrow(APIError);
	});
});
