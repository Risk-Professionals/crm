import { auth } from "@crm/auth";
import type { Db } from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import {
	MICROSOFT_PROVIDER_ID,
	MICROSOFT_RESOURCE_SCOPES,
	type MicrosoftResource,
} from "./microsoft.constants";

export type MicrosoftTokenResult =
	| { outcome: "ok"; accessToken: string }
	| { outcome: "not-connected"; reason: string }
	| { outcome: "needs-reconnect"; reason: string }
	| { outcome: "failed"; reason: string; retryable: true };

export function parseProviderScopes(
	scope: string | null | undefined,
): string[] {
	return scope?.split(/[\s,]+/).filter(Boolean) ?? [];
}

export function isInvalidGrant(error: unknown): boolean {
	const value =
		error instanceof Error
			? `${error.name} ${error.message}`
			: typeof error === "string"
				? error
				: String(JSON.stringify(error));
	return /invalid[_ -]?grant|invalid refresh token|refresh token.+(?:expired|revoked)/i.test(
		value,
	);
}

@Injectable()
export class MicrosoftTokenService {
	private readonly logger = new Logger(MicrosoftTokenService.name);

	constructor(@InjectDatabase() private readonly db: Db) {}

	async grantedScopes(userId: string): Promise<string[]> {
		const account = await this.db.account.findFirst({
			where: { userId, providerId: MICROSOFT_PROVIDER_ID },
			select: { scope: true },
		});

		return parseProviderScopes(account?.scope);
	}

	async hasRefreshToken(userId: string): Promise<boolean> {
		const account = await this.db.account.findFirst({
			where: { userId, providerId: MICROSOFT_PROVIDER_ID },
			select: { refreshToken: true },
		});

		return Boolean(account?.refreshToken);
	}

	async accessTokenFor(
		userId: string,
		resource: MicrosoftResource,
	): Promise<MicrosoftTokenResult> {
		const requiredScope = MICROSOFT_RESOURCE_SCOPES[resource];
		const granted = await this.grantedScopes(userId);

		if (!granted.includes(requiredScope)) {
			return {
				outcome: "not-connected",
				reason: `The ${requiredScope} scope has not been granted.`,
			};
		}

		try {
			const { accessToken } = await this.requestAccessToken(userId);

			if (!accessToken) {
				return {
					outcome: "needs-reconnect",
					reason: "Microsoft returned no access token.",
				};
			}

			return { outcome: "ok", accessToken };
		} catch (error) {
			const invalidGrant = isInvalidGrant(error);
			if (invalidGrant) await this.disconnectDataAccess(userId);
			this.logger.warn({
				message: "Microsoft token refresh failed",
				userId,
				resource,
				reason: error instanceof Error ? error.message : String(error),
			});

			return invalidGrant
				? {
						outcome: "needs-reconnect",
						reason: "Microsoft would not refresh the access token.",
					}
				: {
						outcome: "failed",
						reason: "Microsoft token refresh is temporarily unavailable.",
						retryable: true,
					};
		}
	}

	async disconnectDataAccess(userId: string): Promise<void> {
		await this.db.account.updateMany({
			where: { userId, providerId: MICROSOFT_PROVIDER_ID },
			data: {
				accessToken: null,
				refreshToken: null,
				idToken: null,
				scope: null,
				accessTokenExpiresAt: null,
				refreshTokenExpiresAt: null,
			},
		});
	}

	protected requestAccessToken(
		userId: string,
	): Promise<{ accessToken?: string | null }> {
		return auth.api.getAccessToken({
			body: { providerId: MICROSOFT_PROVIDER_ID, userId },
		});
	}
}
