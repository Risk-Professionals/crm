"use client";

import { authClient, signOut } from "@crm/auth/client";
import { MICROSOFT_GRAPH_SCOPES } from "@crm/auth/microsoft-scopes";
import { SYNC_SCOPES } from "@crm/auth/scopes";
import GoogleLogo from "@crm/ui/components/brand-logos/google";
import MicrosoftLogo from "@crm/ui/components/brand-logos/microsoft";
import { Button } from "@crm/ui/components/button";
import { Spinner } from "@crm/ui/components/spinner";
import { useState } from "react";
import { toast } from "sonner";

export function GrantAccess({
	provider,
}: {
	provider: "microsoft" | "google";
}) {
	const [pending, setPending] = useState(false);

	async function handleGrant() {
		setPending(true);
		const origin = window.location.origin;
		const scopes =
			provider === "microsoft" ? MICROSOFT_GRAPH_SCOPES : SYNC_SCOPES;

		const { error } = await authClient.linkSocial({
			provider,
			scopes: [...scopes],
			callbackURL: `${origin}/`,
			errorCallbackURL: `${origin}/grant-access`,
		});

		if (error) {
			toast.error(error.message ?? `Could not reach ${provider}.`);
			setPending(false);
		}
	}

	async function handleSignOut() {
		const { error } = await signOut();
		if (error) {
			toast.error(error.message ?? "Could not sign out.");
			return;
		}
		window.location.assign("/sign-in");
	}

	return (
		<div className="flex flex-col gap-3">
			<Button
				className="w-full"
				disabled={pending}
				onClick={handleGrant}
				type="button"
			>
				{pending ? (
					<Spinner data-icon="inline-start" />
				) : provider === "microsoft" ? (
					<MicrosoftLogo data-icon="inline-start" />
				) : (
					<GoogleLogo data-icon="inline-start" />
				)}
				Grant read-only access
			</Button>

			<Button
				className="w-full"
				onClick={() => {
					handleSignOut().catch(() => toast.error("Could not sign out."));
				}}
				type="button"
				variant="ghost"
			>
				Sign out
			</Button>
		</div>
	);
}
