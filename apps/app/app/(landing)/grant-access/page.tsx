import { needsGoogleGrant, needsMicrosoftGraphGrant } from "@crm/auth";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthHeading, AuthShell } from "@/components/auth-shell";
import { requireSession, signInAccounts } from "@/lib/session";
import { GrantAccess } from "./grant-access";

export const metadata: Metadata = {
	title: "Grant access",
};

export const instant = false;

export default async function GrantAccessPage() {
	const { user } = await requireSession();
	const accounts = await signInAccounts(user.id);
	const microsoft = needsMicrosoftGraphGrant(accounts);
	const google = needsGoogleGrant(accounts);

	if (!microsoft && !google) redirect("/");

	const provider = microsoft ? "microsoft" : "google";
	const service = microsoft ? "Microsoft 365" : "Gmail and Google Calendar";

	return (
		<AuthShell>
			<AuthHeading
				title="One more step"
				description={`This CRM reads your ${service} mail and calendar so meetings and email threads show up on the right company. It is read-only — nothing is ever sent on your behalf.`}
			/>

			<GrantAccess provider={provider} />

			<p className="text-center text-muted-foreground text-sm/5">
				Only conversations with companies in the CRM are stored. Personal mail
				is discarded without being saved.
			</p>
		</AuthShell>
	);
}
