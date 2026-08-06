"use client";

import { signIn } from "@crm/auth/client";
import MicrosoftLogo from "@crm/ui/components/brand-logos/microsoft";
import { Button } from "@crm/ui/components/button";
import { Spinner } from "@crm/ui/components/spinner";
import { useState } from "react";
import { toast } from "sonner";

export function MicrosoftSignIn() {
	const [pending, setPending] = useState(false);

	async function handleClick() {
		setPending(true);

		const origin = window.location.origin;

		const { error } = await signIn.social({
			provider: "microsoft",
			callbackURL: `${origin}/`,
			errorCallbackURL: `${origin}/sign-in`,
		});

		if (error) {
			toast.error(error.message ?? "Could not reach Microsoft sign-in.");
			setPending(false);
		}
	}

	return (
		<Button
			className="w-full"
			disabled={pending}
			onClick={handleClick}
			type="button"
			variant="outline"
		>
			{pending ? (
				<Spinner data-icon="inline-start" />
			) : (
				<MicrosoftLogo data-icon="inline-start" className="size-4" />
			)}
			Continue with Microsoft
		</Button>
	);
}
