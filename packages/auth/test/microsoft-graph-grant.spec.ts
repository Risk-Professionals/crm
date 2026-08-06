import { describe, expect, test } from "bun:test";
import {
	hasMicrosoftGraphScopes,
	needsMicrosoftGraphGrant,
	signsInWithMicrosoft,
} from "../src/microsoft";

describe("Microsoft Graph access gate", () => {
	test("requires both delegated data scopes for a Microsoft-only user", () => {
		expect(signsInWithMicrosoft([{ providerId: "microsoft" }])).toBe(true);
		expect(
			needsMicrosoftGraphGrant([
				{ providerId: "microsoft", scope: "openid Mail.Read" },
			]),
		).toBe(true);
		expect(
			needsMicrosoftGraphGrant([
				{
					providerId: "microsoft",
					scope: "openid Mail.Read Calendars.Read offline_access",
				},
			]),
		).toBe(false);
	});

	test("does not lock an independent SSO user out of the CRM", () => {
		expect(needsMicrosoftGraphGrant([{ providerId: "corporate-oidc" }])).toBe(
			false,
		);
		expect(
			needsMicrosoftGraphGrant([
				{ providerId: "corporate-oidc" },
				{ providerId: "microsoft", scope: "openid" },
			]),
		).toBe(false);
		expect(
			needsMicrosoftGraphGrant([
				{ providerId: "google" },
				{ providerId: "microsoft", scope: "openid" },
			]),
		).toBe(true);
	});

	test("parses space and comma separated scope storage", () => {
		expect(hasMicrosoftGraphScopes("openid,Mail.Read Calendars.Read")).toBe(
			true,
		);
		expect(hasMicrosoftGraphScopes("Mail.Read")).toBe(false);
	});
});
