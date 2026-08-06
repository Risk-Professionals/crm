import "@crm/env/load";

const DEFAULT_APP_URL = "http://localhost:3000";

const optional = (key: string): string | undefined => {
	const value = process.env[key];
	return value && value.length > 0 ? value : undefined;
};

const googleCredentials = ():
	| { clientId: string; clientSecret: string }
	| undefined => {
	const clientId = optional("GOOGLE_CLIENT_ID");
	const clientSecret = optional("GOOGLE_CLIENT_SECRET");

	if (!clientId || !clientSecret) {
		if (clientId || clientSecret) {
			throw new Error(
				"GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together.",
			);
		}
		return undefined;
	}

	return { clientId, clientSecret };
};

const microsoftCredentials = ():
	| { clientId: string; clientSecret: string; tenantId: string }
	| undefined => {
	const clientId = optional("MICROSOFT_CLIENT_ID");
	const clientSecret = optional("MICROSOFT_CLIENT_SECRET");
	const tenantId = optional("MICROSOFT_TENANT_ID");

	if (!clientId || !clientSecret || !tenantId) {
		if (clientId || clientSecret || tenantId) {
			throw new Error(
				"MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and MICROSOFT_TENANT_ID must be set together.",
			);
		}
		return undefined;
	}

	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			tenantId,
		)
	) {
		throw new Error("MICROSOFT_TENANT_ID must be a tenant GUID.");
	}

	return { clientId, clientSecret, tenantId };
};

const appUrls = (
	optional("APP_URL") ??
	optional("BETTER_AUTH_URL") ??
	DEFAULT_APP_URL
)
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);

const appUrl = appUrls[0] ?? DEFAULT_APP_URL;

export const env = {
	appUrl,
	google: googleCredentials(),
	microsoft: microsoftCredentials(),
	cookieDomain: optional("AUTH_COOKIE_DOMAIN"),
	trustedOrigins: [...new Set(appUrls)],
	isProduction: process.env.NODE_ENV === "production",
} as const;

export function isGoogleConfigured(): boolean {
	return env.google !== undefined;
}

export function isMicrosoftConfigured(): boolean {
	return env.microsoft !== undefined;
}

export { appUrl };
