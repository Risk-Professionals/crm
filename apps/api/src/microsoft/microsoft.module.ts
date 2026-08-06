import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module";
import { GoogleModule } from "../google/google.module";
import { SyncCoreModule } from "../sync/sync-core.module";
import { MicrosoftCalendarClient } from "./calendar.client";
import { MicrosoftCalendarSyncService } from "./calendar-sync.service";
import { GraphClient } from "./graph.client";
import { MicrosoftMailClient } from "./mail.client";
import { MicrosoftMailSyncService } from "./mail-sync.service";
import { MicrosoftConnectionService } from "./microsoft-connection.service";
import { MicrosoftSyncService } from "./microsoft-sync.service";
import { MicrosoftSyncStateService } from "./microsoft-sync-state.service";
import { MicrosoftTokenService } from "./microsoft-token.service";

@Module({
	imports: [AgentModule, GoogleModule, SyncCoreModule],
	providers: [
		GraphClient,
		MicrosoftTokenService,
		MicrosoftMailClient,
		MicrosoftCalendarClient,
		MicrosoftSyncStateService,
		MicrosoftMailSyncService,
		MicrosoftCalendarSyncService,
		MicrosoftConnectionService,
		MicrosoftSyncService,
	],
	exports: [
		GraphClient,
		MicrosoftTokenService,
		MicrosoftMailClient,
		MicrosoftCalendarClient,
		MicrosoftConnectionService,
		MicrosoftSyncService,
	],
})
export class MicrosoftModule {}
