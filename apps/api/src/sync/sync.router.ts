import { BadRequestException, Inject } from "@nestjs/common";
import {
	Ctx,
	Input,
	Mutation,
	Query,
	Router,
	UseMiddlewares,
} from "nestjs-trpc";
import type { z } from "zod";
import { ConversationService } from "../google/conversation.service";
import { MicrosoftConnectionService } from "../microsoft/microsoft-connection.service";
import { MicrosoftSyncService } from "../microsoft/microsoft-sync.service";
import type { AuthedTrpcContext } from "../trpc/context.types";
import { AuthMiddleware } from "../trpc/middlewares/auth.middleware";
import {
	setMicrosoftAutoCreateInput,
	syncEventInput,
	syncThreadInput,
} from "./sync.contracts";

@Router({ alias: "sync" })
@UseMiddlewares(AuthMiddleware)
export class SyncRouter {
	constructor(
		@Inject(MicrosoftConnectionService)
		private readonly connection: MicrosoftConnectionService,
		@Inject(MicrosoftSyncService) private readonly sync: MicrosoftSyncService,
		@Inject(ConversationService)
		private readonly conversations: ConversationService,
	) {}

	@Query()
	status(@Ctx() ctx: AuthedTrpcContext) {
		return this.connection.status(ctx.user.id);
	}

	@Mutation()
	async disconnect(@Ctx() ctx: AuthedTrpcContext) {
		return this.connection.disconnect(ctx.user.id);
	}

	@Mutation()
	async purgeSyncedData(@Ctx() ctx: AuthedTrpcContext) {
		return this.connection.purgeSyncedData(ctx.user.id);
	}

	@Mutation()
	async syncNow(@Ctx() ctx: AuthedTrpcContext) {
		const summary = await this.sync.runForUser(ctx.user.id);
		if (summary.failed > 0)
			throw new BadRequestException(
				`Microsoft sync failed for ${summary.failed} source${summary.failed === 1 ? "" : "s"}.`,
			);
		return this.connection.status(ctx.user.id);
	}

	@Mutation({ input: setMicrosoftAutoCreateInput })
	async setAutoCreate(
		@Ctx() ctx: AuthedTrpcContext,
		@Input() input: z.infer<typeof setMicrosoftAutoCreateInput>,
	) {
		await this.connection.setAutoCreate(
			ctx.user.id,
			input.source,
			input.enabled,
		);
		return this.connection.status(ctx.user.id);
	}

	@Query({ input: syncThreadInput })
	thread(@Input("threadId") threadId: string) {
		return this.conversations.thread(threadId);
	}

	@Query({ input: syncEventInput })
	event(@Input("eventId") eventId: string) {
		return this.conversations.event(eventId);
	}
}
