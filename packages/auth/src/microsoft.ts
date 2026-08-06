import { APIError } from "better-auth/api";

export {
	hasMicrosoftGraphScopes,
	MICROSOFT_GRAPH_SCOPES,
	MICROSOFT_PROVIDER_ID,
	needsMicrosoftGraphGrant,
	signsInWithMicrosoft,
} from "./microsoft-scopes";

export function microsoftProfileToUser(
	profile: Record<string, unknown>,
	tenantId: string,
) {
	const tid = typeof profile.tid === "string" ? profile.tid : null;
	const oid = typeof profile.oid === "string" ? profile.oid : null;

	if (!tid || !oid || tid.toLowerCase() !== tenantId.toLowerCase()) {
		throw new APIError("FORBIDDEN", {
			message:
				"This Microsoft account does not belong to the configured tenant.",
		});
	}

	const email = [profile.email, profile.preferred_username, profile.upn]
		.find(
			(value): value is string =>
				typeof value === "string" && /^[^\s@]+@[^\s@]+$/.test(value.trim()),
		)
		?.trim()
		.toLowerCase();

	if (!email) {
		throw new APIError("FORBIDDEN", {
			message:
				"Microsoft did not provide an approved email address for this account. Ask your Entra administrator to configure the email optional claim.",
		});
	}

	return {
		id: `${tid}:${oid}`,
		email,
		emailVerified: false,
	};
}
