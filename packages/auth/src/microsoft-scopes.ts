import type { SignInAccount } from "./scopes";

export const MICROSOFT_PROVIDER_ID = "microsoft";
export const MICROSOFT_GRAPH_SCOPES = ["Mail.Read", "Calendars.Read"] as const;

export function hasMicrosoftGraphScopes(
	scope: string | null | undefined,
): boolean {
	const granted = new Set(scope?.split(/[\s,]+/).filter(Boolean) ?? []);
	return MICROSOFT_GRAPH_SCOPES.every((needed) => granted.has(needed));
}

export function signsInWithMicrosoft(
	accounts: readonly SignInAccount[],
): boolean {
	return (
		accounts.some((account) => account.providerId === MICROSOFT_PROVIDER_ID) &&
		accounts.every(
			(account) =>
				account.providerId === MICROSOFT_PROVIDER_ID ||
				account.providerId === "google",
		)
	);
}

export function needsMicrosoftGraphGrant(
	accounts: readonly SignInAccount[],
): boolean {
	if (!signsInWithMicrosoft(accounts)) return false;
	return !accounts.some((account) => hasMicrosoftGraphScopes(account.scope));
}
