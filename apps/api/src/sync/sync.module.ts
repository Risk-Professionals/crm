import { Module } from "@nestjs/common";
import { GoogleModule } from "../google/google.module";
import { MicrosoftModule } from "../microsoft/microsoft.module";
import { TrpcModule } from "../trpc/trpc.module";
import { ProviderSyncController } from "./sync.controller";
import { SyncRouter } from "./sync.router";
import { SyncCoreModule } from "./sync-core.module";

@Module({
	imports: [TrpcModule, SyncCoreModule, GoogleModule, MicrosoftModule],
	controllers: [ProviderSyncController],
	providers: [SyncRouter],
})
export class SyncModule {}
