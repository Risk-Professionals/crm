"use client";

import Warning from "@carbon/icons-react/es/Warning";
import { authClient } from "@crm/auth/client";
import { MICROSOFT_GRAPH_SCOPES } from "@crm/auth/microsoft-scopes";
import { Alert, AlertDescription, AlertTitle } from "@crm/ui/components/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@crm/ui/components/alert-dialog";
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
import { Switch } from "@crm/ui/components/switch";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useCrmCache } from "@/lib/trpc/cache";
import { useTRPC } from "@/lib/trpc/client";

export function MicrosoftConnection({
	connectError,
}: {
	connectError?: string;
}) {
	const trpc = useTRPC();
	const cache = useCrmCache();
	const connection = useQuery(trpc.sync.status.queryOptions());
	const [connecting, setConnecting] = useState(false);
	const syncNow = useMutation(
		trpc.sync.syncNow.mutationOptions({
			onSuccess: async () => {
				await cache.sync();
				toast.success("Microsoft sync completed.");
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const disconnect = useMutation(
		trpc.sync.disconnect.mutationOptions({
			onSuccess: async () => {
				await cache.sync();
				toast.success("Microsoft data access disconnected locally.");
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const purge = useMutation(
		trpc.sync.purgeSyncedData.mutationOptions({
			onSuccess: async ({ purged }) => {
				await cache.sync();
				toast.success(`${purged} synced records removed.`);
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const autoCreate = useMutation(
		trpc.sync.setAutoCreate.mutationOptions({
			onSuccess: () => cache.sync(),
			onError: (error) => toast.error(error.message),
		}),
	);

	async function handleConnect() {
		setConnecting(true);
		const returnUrl = `${window.location.origin}${window.location.pathname}`;
		const { error } = await authClient.linkSocial({
			provider: "microsoft",
			scopes: [...MICROSOFT_GRAPH_SCOPES],
			callbackURL: returnUrl,
			errorCallbackURL: `${returnUrl}?connection=microsoft`,
		});
		if (error) {
			toast.error(error.message ?? "Could not reach Microsoft sign-in.");
			setConnecting(false);
		}
	}

	const data = connection.data;
	if (!data?.configured) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Microsoft 365</CardTitle>
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

	const connected =
		data.sources.every((source) => source.connected) && data.hasRefreshToken;
	const reconnect = data.sources.some(
		(source) => source.status === "NEEDS_RECONNECT",
	);
	const failed = data.sources.filter((source) => source.status === "FAILED");
	const healthy = connected && !reconnect && failed.length === 0;

	return (
		<Card>
			<CardHeader>
				<CardTitle>Microsoft 365 Mail and Calendar</CardTitle>
				<CardDescription>
					Read-only Outlook mail and calendar sync through your linked Entra
					account.
				</CardDescription>
				<CardAction>
					<StatusIndicator
						size="sm"
						tone={healthy ? "success" : failed.length ? "warning" : "neutral"}
						label={
							reconnect
								? "Reconnect required"
								: failed.length
									? "Sync failed"
									: connected
										? "Connected"
										: "Not connected"
						}
					/>
				</CardAction>
			</CardHeader>

			<CardContent className="flex flex-col gap-5">
				{connectError || reconnect || failed.length ? (
					<Alert variant="destructive">
						<Icon icon={Warning} />
						<AlertTitle>
							{reconnect
								? "Microsoft access needs reconnecting"
								: failed.length
									? "Microsoft sync needs attention"
									: "Microsoft did not finish connecting"}
						</AlertTitle>
						<AlertDescription>
							{failed.length
								? failed
										.map(
											(source) =>
												`${source.source === "mail" ? "Mail" : "Calendar"}: ${source.lastError ?? "Sync failed after repeated attempts."}`,
										)
										.join(" ")
								: "Grant Mail.Read and Calendars.Read again. CRM access remains available for users who sign in through an independent SSO provider."}
						</AlertDescription>
					</Alert>
				) : null}

				{connected && !reconnect ? (
					<>
						<div className="flex flex-col gap-3">
							{data.sources.map((source) => (
								<div
									className="flex items-center justify-between gap-4"
									key={source.source}
								>
									<div>
										<p className="font-medium text-sm">
											{source.source === "mail"
												? "Outlook mail"
												: "Outlook calendar"}
										</p>
										<p className="text-muted-foreground text-xs">
											{source.lastSyncedAt
												? `Last synced ${new Date(source.lastSyncedAt).toLocaleString()}`
												: "Ready to establish the first cursor"}
										</p>
									</div>
									<Switch
										checked={source.autoCreate}
										disabled={autoCreate.isPending}
										onCheckedChange={(enabled) =>
											autoCreate.mutate({ source: source.source, enabled })
										}
										aria-label={`Automatically create records from ${source.source}`}
									/>
								</div>
							))}
						</div>

						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="outline"
								disabled={syncNow.isPending}
								onClick={() => syncNow.mutate()}
							>
								{syncNow.isPending ? (
									<Spinner data-icon="inline-start" />
								) : null}
								Sync now
							</Button>
							<AlertDialog>
								<AlertDialogTrigger asChild>
									<Button type="button" variant="outline">
										Disconnect
									</Button>
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>
											Disconnect Microsoft data access?
										</AlertDialogTitle>
										<AlertDialogDescription>
											This removes locally stored Microsoft tokens and stops
											future sync. Existing CRM activity is retained.
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>Cancel</AlertDialogCancel>
										<AlertDialogAction onClick={() => disconnect.mutate()}>
											Disconnect
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
							<AlertDialog>
								<AlertDialogTrigger asChild>
									<Button type="button" variant="destructive">
										Purge Microsoft data
									</Button>
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>
											Remove Microsoft-synced activity?
										</AlertDialogTitle>
										<AlertDialogDescription>
											This permanently removes Outlook messages, meetings, and
											their projected activities. It does not remove CRM records
											created from them.
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>Cancel</AlertDialogCancel>
										<AlertDialogAction
											variant="destructive"
											onClick={() => purge.mutate()}
										>
											Purge data
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						</div>
					</>
				) : (
					<Button disabled={connecting} onClick={handleConnect} type="button">
						{connecting ? (
							<Spinner data-icon="inline-start" />
						) : (
							<MicrosoftLogo data-icon="inline-start" />
						)}
						{reconnect ? "Reconnect Microsoft" : "Connect Microsoft 365"}
					</Button>
				)}
			</CardContent>
		</Card>
	);
}
