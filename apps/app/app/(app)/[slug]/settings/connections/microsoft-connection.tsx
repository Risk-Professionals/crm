"use client";

import Warning from "@carbon/icons-react/es/Warning";
import { authClient } from "@crm/auth/client";
import { Alert, AlertDescription, AlertTitle } from "@crm/ui/components/alert";
import MicrosoftLogo from "@crm/ui/components/brand-logos/microsoft";
import { Button } from "@crm/ui/components/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@crm/ui/components/card";
import { Icon } from "@crm/ui/components/icon";
import { Spinner } from "@crm/ui/components/spinner";
import { StatusIndicator } from "@crm/ui/components/status-indicator";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc/client";

export function MicrosoftConnection({
	connectError,
}: {
	connectError?: string;
}) {
	const trpc = useTRPC();
	const connection = useQuery(trpc.sso.microsoftConnection.queryOptions());
	const [pending, setPending] = useState(false);

	async function handleConnect() {
		setPending(true);

		const origin = window.location.origin;
		const returnUrl = `${origin}/settings/connections`;

		const { error } = await authClient.linkSocial({
			provider: "microsoft",
			callbackURL: returnUrl,
			errorCallbackURL: `${returnUrl}?connection=microsoft`,
		});

		if (error) {
			toast.error(error.message ?? "Could not reach Microsoft sign-in.");
			setPending(false);
		}
	}

	if (!connection.data?.configured) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Microsoft</CardTitle>
					<CardDescription>
						Microsoft sign-in is not configured for this installation.
					</CardDescription>
					<CardAction>
						<StatusIndicator size="sm" tone="neutral" label="Not configured" />
					</CardAction>
				</CardHeader>
			</Card>
		);
	}

	if (connection.data.linked) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Microsoft</CardTitle>
					<CardDescription>
						Your Entra identity is linked and can be used to sign in without
						changing your CRM user or workspace role.
					</CardDescription>
					<CardAction>
						<StatusIndicator size="sm" tone="success" label="Connected" />
					</CardAction>
				</CardHeader>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Microsoft</CardTitle>
				<CardDescription>
					Link your Entra identity while signed in to keep this CRM user,
					workspace role, conversations, and records attached to the same
					account.
				</CardDescription>
				<CardAction>
					<StatusIndicator size="sm" tone="neutral" label="Not connected" />
				</CardAction>
			</CardHeader>

			<CardContent>
				{connectError ? (
					<Alert variant="destructive">
						<Icon icon={Warning} />
						<AlertTitle>Microsoft did not finish connecting</AlertTitle>
						<AlertDescription>
							Microsoft returned an error before the identity was linked. Try
							again or ask your Entra administrator to verify the tenant and
							redirect URI.
						</AlertDescription>
					</Alert>
				) : null}

				<Button disabled={pending} onClick={handleConnect} type="button">
					{pending ? (
						<Spinner data-icon="inline-start" />
					) : (
						<MicrosoftLogo data-icon="inline-start" className="size-4" />
					)}
					Link Microsoft identity
				</Button>
			</CardContent>
		</Card>
	);
}
