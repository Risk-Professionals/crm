import { Module } from "@nestjs/common";
import { SyncLeaseService } from "./sync-lease.service";

@Module({
	providers: [SyncLeaseService],
	exports: [SyncLeaseService],
})
export class SyncModule {}
