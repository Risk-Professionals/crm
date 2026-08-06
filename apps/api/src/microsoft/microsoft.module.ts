import { Module } from "@nestjs/common";
import { MicrosoftCalendarClient } from "./calendar.client";
import { GraphClient } from "./graph.client";
import { MicrosoftMailClient } from "./mail.client";
import { MicrosoftTokenService } from "./microsoft-token.service";

@Module({
	providers: [
		GraphClient,
		MicrosoftTokenService,
		MicrosoftMailClient,
		MicrosoftCalendarClient,
	],
	exports: [
		GraphClient,
		MicrosoftTokenService,
		MicrosoftMailClient,
		MicrosoftCalendarClient,
	],
})
export class MicrosoftModule {}
