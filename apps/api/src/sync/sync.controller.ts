import {
	Controller,
	ForbiddenException,
	Headers,
	Logger,
	Post,
	ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { EnvironmentVariables } from "../config/env.validation";
import { MicrosoftSyncService } from "../microsoft/microsoft-sync.service";

@Controller("internal/sync")
export class ProviderSyncController {
	private readonly logger = new Logger(ProviderSyncController.name);
	private readonly secret: string | undefined;

	constructor(
		private readonly sync: MicrosoftSyncService,
		config: ConfigService<EnvironmentVariables, true>,
	) {
		this.secret = config.get("CRON_SECRET", { infer: true });
	}

	@Post()
	@AllowAnonymous()
	async run(@Headers("authorization") authorization?: string) {
		if (!this.secret) {
			this.logger.error({
				message: "CRON_SECRET is not set; refusing to run the sync route.",
			});
			throw new ServiceUnavailableException("Sync is not configured.");
		}
		if (!timingSafeEquals(authorization ?? "", `Bearer ${this.secret}`)) {
			throw new ForbiddenException();
		}
		return this.sync.runDue();
	}
}

function timingSafeEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let index = 0; index < a.length; index += 1)
		mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return mismatch === 0;
}
