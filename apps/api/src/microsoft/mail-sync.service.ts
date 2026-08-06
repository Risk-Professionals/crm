import {
	ActivityType,
	EmailDirection,
	type MailboxSyncModel as MailboxSync,
	type Prisma,
	RecordSource,
	SyncProvider,
} from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { ActivityStampService } from "../crm/activity-stamp.service";
import {
	GoogleMatchService,
	type MatchContext,
} from "../google/google-match.service";
import type { Participant } from "../google/participants";
import { type GraphMessage, MicrosoftMailClient } from "./mail.client";
import { MicrosoftSyncStateService } from "./microsoft-sync-state.service";
import { MicrosoftTokenService } from "./microsoft-token.service";

const MAX_PAGES_PER_RUN = 5;

export type MicrosoftMailOutcome = {
	resource: "mail";
	userId: string;
	status: "synced" | "skipped" | "reconnect" | "rate-limited" | "failed";
	written?: number;
	removed?: number;
	reason?: string;
};

type ParsedMessage = {
	providerId: string;
	threadId: string;
	rfcMessageId: string;
	subject: string | null;
	from: Participant;
	recipients: Array<Participant & { kind: "to" | "cc" }>;
	body: string;
	sentAt: Date;
	webUrl: string | null;
};

@Injectable()
export class MicrosoftMailSyncService {
	private readonly logger = new Logger(MicrosoftMailSyncService.name);

	constructor(
		private readonly mail: MicrosoftMailClient,
		private readonly tokens: MicrosoftTokenService,
		private readonly match: GoogleMatchService,
		private readonly state: MicrosoftSyncStateService,
		private readonly stamp: ActivityStampService,
	) {}

	async sync(
		row: MailboxSync,
		owner: string | null = row.leaseOwner,
	): Promise<MicrosoftMailOutcome> {
		const token = await this.tokens.accessTokenFor(row.userId, "mail");
		if (token.outcome === "not-connected") {
			await this.state.markIdle(row.id, {}, owner);
			return {
				resource: "mail",
				userId: row.userId,
				status: "skipped",
				reason: token.reason,
			};
		}
		if (token.outcome === "needs-reconnect") {
			await this.state.markNeedsReconnect(row.id, token.reason, owner);
			return {
				resource: "mail",
				userId: row.userId,
				status: "reconnect",
				reason: token.reason,
			};
		}
		if (token.outcome === "failed") {
			await this.state.markFailed(row.id, token.reason, owner);
			return {
				resource: "mail",
				userId: row.userId,
				status: "failed",
				reason: token.reason,
			};
		}

		const folderId = row.folderId;
		if (!folderId) {
			await this.state.markFailed(
				row.id,
				"Microsoft mail sync has no folder identity.",
				owner,
			);
			return {
				resource: "mail",
				userId: row.userId,
				status: "failed",
				reason: "Missing folder identity.",
			};
		}

		const baseline =
			!row.providerCursor && !row.reconciliationStartedAt && !row.lastSyncedAt;
		const ingestAfter =
			row.ingestAfter ??
			(await this.state.ensureIngestAfter(row.id, new Date(), owner));
		const generation = row.reconciliationStartedAt ?? new Date();
		let context: MatchContext | null = null;
		let cursor = row.providerPageCursor ?? row.providerCursor;
		let written = 0;
		let removed = 0;

		for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
			const result = await this.mail.delta(token.accessToken, {
				folderId,
				cursor,
			});
			if (result.outcome === "cursor-invalid") {
				await this.state.beginReconciliation(row.id, result.reason, owner);
				return {
					resource: "mail",
					userId: row.userId,
					status: "synced",
					reason:
						"Cursor reset; reconciliation will continue on the next pass.",
				};
			}
			if (result.outcome !== "ok") return this.failure(row, result, owner);
			await this.state.assertOwned(row.id, owner);

			if (!context) context = await this.matchContext();
			for (const message of result.data.value) {
				const applied = await this.apply(
					row,
					folderId,
					generation,
					ingestAfter,
					message,
					context,
					owner,
				);
				if (applied === "written") written += 1;
				if (applied === "removed") removed += 1;
			}

			const next = result.data["@odata.nextLink"] ?? null;
			const delta = result.data["@odata.deltaLink"] ?? null;
			if (!next && !delta) {
				await this.state.markFailed(
					row.id,
					"Microsoft mail delta returned no continuation link.",
					owner,
				);
				return {
					resource: "mail",
					userId: row.userId,
					status: "failed",
					reason: "No delta continuation link.",
				};
			}

			await this.state.commitPage(row.id, { next, delta }, owner);
			if (next) {
				cursor = next;
				continue;
			}

			if (row.reconciliationStartedAt) {
				removed += await this.reconcileFolder(row, folderId, generation, owner);
				await this.state.finishReconciliation(row.id, owner);
			}
			this.logger.log({
				message: baseline
					? "Microsoft mail baseline established"
					: "Microsoft mail delta complete",
				userId: row.userId,
				folderId,
				written,
				removed,
			});
			return {
				resource: "mail",
				userId: row.userId,
				status: "synced",
				written,
				removed,
			};
		}

		return {
			resource: "mail",
			userId: row.userId,
			status: "synced",
			written,
			removed,
			reason: "Page budget reached; continuing from the saved page cursor.",
		};
	}

	private async matchContext(): Promise<MatchContext> {
		const [internal, suppressedDomains, suppressedEmails] = await Promise.all([
			this.match.internalIdentity(),
			this.match.suppressedDomains(),
			this.match.suppressedEmails(),
		]);
		return {
			ourAddresses: internal.addresses,
			ourDomains: internal.domains,
			suppressedDomains,
			suppressedEmails,
		};
	}

	private async apply(
		row: MailboxSync,
		folderId: string,
		generation: Date,
		ingestAfter: Date,
		message: GraphMessage,
		context: MatchContext,
		owner: string | null,
	): Promise<"written" | "removed" | "ignored"> {
		return this.state.withBusinessWrite(row.id, owner, async (tx) => {
			if (message["@removed"])
				return this.remove(tx, row, folderId, message.id);
			if (message.isDraft) return "ignored";
			const parsed = this.parse(row.userId, message);
			if (!parsed) return "ignored";
			if (parsed.sentAt < ingestAfter) {
				const known = await tx.emailMessage.findUnique({
					where: {
						syncedByUserId_provider_providerMessageId: {
							syncedByUserId: row.userId,
							provider: SyncProvider.MICROSOFT,
							providerMessageId: parsed.providerId,
						},
					},
					select: { id: true },
				});
				if (!known) return "ignored";
			}

			const mailbox = await tx.user.findUnique({
				where: { id: row.userId },
				select: { email: true },
			});
			if (!mailbox) return "ignored";
			const outbound = parsed.from.email === mailbox.email.toLowerCase();

			const existingThread = await tx.emailThread.findUnique({
				where: {
					providerUserId_provider_providerThreadId: {
						providerUserId: row.userId,
						provider: SyncProvider.MICROSOFT,
						providerThreadId: parsed.threadId,
					},
				},
				select: { id: true, companyId: true, contactId: true },
			});

			let companyId = existingThread?.companyId ?? null;
			let contactId = existingThread?.contactId ?? null;
			if (!existingThread) {
				const repliedTo =
					outbound ||
					(await this.hasOutbound(
						tx,
						row.userId,
						parsed.threadId,
						mailbox.email,
					));
				const match = await this.match.resolve(
					{
						participants: [parsed.from, ...parsed.recipients],
						allowCreate: row.autoCreate && repliedTo,
						source: RecordSource.EMAIL,
						ownerId: row.userId,
					},
					context,
				);
				companyId = match.companyId;
				contactId = match.contactId;
				if (!companyId && !contactId) return "ignored";
			}

			const syntheticRoot = `${row.userId}:microsoft:${parsed.threadId}`;
			const thread = await tx.emailThread.upsert({
				where: {
					providerUserId_provider_providerThreadId: {
						providerUserId: row.userId,
						provider: SyncProvider.MICROSOFT,
						providerThreadId: parsed.threadId,
					},
				},
				create: {
					rootMessageId: syntheticRoot,
					subject: parsed.subject,
					provider: SyncProvider.MICROSOFT,
					providerThreadId: parsed.threadId,
					providerUserId: row.userId,
					companyId,
					contactId,
					firstMessageAt: parsed.sentAt,
					lastMessageAt: parsed.sentAt,
				},
				update: { subject: parsed.subject, companyId, contactId },
				select: { id: true },
			});

			await tx.emailMessage.upsert({
				where: {
					syncedByUserId_provider_providerMessageId: {
						syncedByUserId: row.userId,
						provider: SyncProvider.MICROSOFT,
						providerMessageId: parsed.providerId,
					},
				},
				create: {
					threadId: thread.id,
					rfcMessageId: parsed.rfcMessageId,
					syncedByUserId: row.userId,
					provider: SyncProvider.MICROSOFT,
					providerMessageId: parsed.providerId,
					providerFolderId: folderId,
					providerSeenAt: generation,
					providerWebUrl: parsed.webUrl,
					direction: outbound
						? EmailDirection.OUTBOUND
						: EmailDirection.INBOUND,
					fromEmail: parsed.from.email,
					fromName: parsed.from.name,
					recipients: parsed.recipients,
					subject: parsed.subject,
					snippet: this.snippet(parsed.body),
					body: parsed.body || null,
					sentAt: parsed.sentAt,
				},
				update: {
					threadId: thread.id,
					providerFolderId: folderId,
					providerSeenAt: generation,
					providerWebUrl: parsed.webUrl,
					fromEmail: parsed.from.email,
					fromName: parsed.from.name,
					recipients: parsed.recipients,
					subject: parsed.subject,
					snippet: this.snippet(parsed.body),
					body: parsed.body || null,
					sentAt: parsed.sentAt,
				},
			});

			await this.refreshThread(
				tx,
				thread.id,
				row.userId,
				parsed.subject,
				companyId,
				contactId,
			);
			return "written";
		});
	}

	private async remove(
		tx: Prisma.TransactionClient,
		row: MailboxSync,
		folderId: string,
		providerId: string,
	): Promise<"removed" | "ignored"> {
		const message = await tx.emailMessage.findUnique({
			where: {
				syncedByUserId_provider_providerMessageId: {
					syncedByUserId: row.userId,
					provider: SyncProvider.MICROSOFT,
					providerMessageId: providerId,
				},
			},
			select: { id: true, threadId: true, providerFolderId: true },
		});
		if (!message || message.providerFolderId !== folderId) return "ignored";
		await tx.emailMessage.delete({ where: { id: message.id } });
		await this.repairThread(tx, message.threadId, row.userId);
		await this.stamp.recomputeAll(tx);
		return "removed";
	}

	private async reconcileFolder(
		row: MailboxSync,
		folderId: string,
		generation: Date,
		owner: string | null,
	): Promise<number> {
		return this.state.withBusinessWrite(row.id, owner, async (tx) => {
			const stale = await tx.emailMessage.findMany({
				where: {
					syncedByUserId: row.userId,
					provider: SyncProvider.MICROSOFT,
					providerFolderId: folderId,
					OR: [
						{ providerSeenAt: null },
						{ providerSeenAt: { lt: generation } },
					],
				},
				select: { id: true, threadId: true },
			});
			if (stale.length === 0) return 0;
			await tx.emailMessage.deleteMany({
				where: { id: { in: stale.map((item) => item.id) } },
			});
			for (const threadId of new Set(stale.map((item) => item.threadId)))
				await this.repairThread(tx, threadId, row.userId);
			await this.stamp.recomputeAll(tx);
			return stale.length;
		});
	}

	private async repairThread(
		tx: Prisma.TransactionClient,
		threadId: string,
		userId: string,
	): Promise<void> {
		const stats = await tx.emailMessage.aggregate({
			where: { threadId },
			_count: { _all: true },
			_min: { sentAt: true },
			_max: { sentAt: true },
		});
		if (!stats._min.sentAt || !stats._max.sentAt) {
			await tx.emailThread.deleteMany({ where: { id: threadId } });
			return;
		}
		const thread = await tx.emailThread.update({
			where: { id: threadId },
			data: {
				messageCount: stats._count._all,
				firstMessageAt: stats._min.sentAt,
				lastMessageAt: stats._max.sentAt,
			},
			select: { subject: true, companyId: true, contactId: true },
		});
		const latest = await tx.emailMessage.findFirst({
			where: { threadId },
			orderBy: { sentAt: "desc" },
			select: { snippet: true },
		});
		await tx.activity.upsert({
			where: { emailThreadId: threadId },
			create: {
				type: ActivityType.EMAIL,
				subject: thread.subject ?? "(no subject)",
				body: latest?.snippet ?? null,
				occurredAt: stats._max.sentAt,
				companyId: thread.companyId,
				contactId: thread.contactId,
				createdById: userId,
				emailThreadId: threadId,
				meta: { synced: true, source: "microsoft" },
			},
			update: {
				body: latest?.snippet ?? null,
				occurredAt: stats._max.sentAt,
			},
		});
	}

	private async refreshThread(
		tx: Prisma.TransactionClient,
		threadId: string,
		userId: string,
		subject: string | null,
		companyId: string | null,
		contactId: string | null,
	): Promise<void> {
		const stats = await tx.emailMessage.aggregate({
			where: { threadId },
			_count: { _all: true },
			_min: { sentAt: true },
			_max: { sentAt: true },
		});
		if (!stats._min.sentAt || !stats._max.sentAt) return;
		const thread = await tx.emailThread.update({
			where: { id: threadId },
			data: {
				messageCount: stats._count._all,
				firstMessageAt: stats._min.sentAt,
				lastMessageAt: stats._max.sentAt,
				...(subject ? { subject } : {}),
			},
			select: { companyId: true, contactId: true, subject: true },
		});
		const targetCompany = companyId ?? thread.companyId;
		const targetContact = contactId ?? thread.contactId;
		const latest = await tx.emailMessage.findFirst({
			where: { threadId },
			orderBy: { sentAt: "desc" },
			select: { snippet: true },
		});
		const activity = await tx.activity.upsert({
			where: { emailThreadId: threadId },
			create: {
				type: ActivityType.EMAIL,
				subject: thread.subject ?? "(no subject)",
				body: latest?.snippet ?? null,
				occurredAt: stats._max.sentAt,
				companyId: targetCompany,
				contactId: targetContact,
				createdById: userId,
				emailThreadId: threadId,
				meta: { synced: true, source: "microsoft" },
			},
			update: { body: latest?.snippet ?? null, occurredAt: stats._max.sentAt },
			select: { createdAt: true },
		});
		await this.stamp.touch(
			{ companyId: targetCompany, contactId: targetContact },
			activity.createdAt,
			tx,
		);
	}

	private async hasOutbound(
		tx: Prisma.TransactionClient,
		userId: string,
		threadId: string,
		mailbox: string,
	): Promise<boolean> {
		return (
			(await tx.emailMessage.findFirst({
				where: {
					thread: {
						providerUserId: userId,
						provider: SyncProvider.MICROSOFT,
						providerThreadId: threadId,
					},
					fromEmail: mailbox.toLowerCase(),
				},
				select: { id: true },
			})) !== null
		);
	}

	private parse(userId: string, message: GraphMessage): ParsedMessage | null {
		const fromAddress = message.from?.emailAddress?.address
			?.trim()
			.toLowerCase();
		const sentAtRaw = message.sentDateTime ?? message.receivedDateTime;
		if (!message.id || !message.conversationId || !fromAddress || !sentAtRaw)
			return null;
		const sentAt = new Date(sentAtRaw);
		if (Number.isNaN(sentAt.getTime())) return null;
		const recipients = [
			...(message.toRecipients ?? []).map((recipient) => ({
				recipient,
				kind: "to" as const,
			})),
			...(message.ccRecipients ?? []).map((recipient) => ({
				recipient,
				kind: "cc" as const,
			})),
		].flatMap(({ recipient, kind }) => {
			const email = recipient.emailAddress?.address?.trim().toLowerCase();
			return email
				? [{ email, name: recipient.emailAddress?.name?.trim() || null, kind }]
				: [];
		});
		return {
			providerId: message.id,
			threadId: message.conversationId,
			rfcMessageId: `${userId}:microsoft:${message.id}`,
			subject: message.subject?.trim() || null,
			from: {
				email: fromAddress,
				name: message.from?.emailAddress?.name?.trim() || null,
			},
			recipients,
			body: this.text(message.body?.content ?? message.bodyPreview ?? ""),
			sentAt,
			webUrl: message.webLink ?? null,
		};
	}

	private text(value: string): string {
		return value
			.replace(/<br\s*\/?\s*>/gi, "\n")
			.replace(/<\/p>/gi, "\n")
			.replace(/<[^>]+>/g, "")
			.replace(/&nbsp;/gi, " ")
			.replace(/&amp;/gi, "&")
			.replace(/&lt;/gi, "<")
			.replace(/&gt;/gi, ">")
			.replace(/\r/g, "")
			.trim();
	}

	private snippet(value: string): string | null {
		const compact = value.replace(/\s+/g, " ").trim();
		return compact ? compact.slice(0, 280) : null;
	}

	private async failure(
		row: MailboxSync,
		result: { outcome: string; reason: string; retryAfterMs?: number },
		owner?: string | null,
	): Promise<MicrosoftMailOutcome> {
		if (result.outcome === "unauthorized") {
			await this.state.markNeedsReconnect(row.id, result.reason, owner);
			return {
				resource: "mail",
				userId: row.userId,
				status: "reconnect",
				reason: result.reason,
			};
		}
		if (result.outcome === "rate-limited") {
			await this.state.markRateLimited(
				row.id,
				result.retryAfterMs ?? 60_000,
				owner,
			);
			return {
				resource: "mail",
				userId: row.userId,
				status: "rate-limited",
				reason: result.reason,
			};
		}
		await this.state.markFailed(row.id, result.reason, owner);
		return {
			resource: "mail",
			userId: row.userId,
			status: "failed",
			reason: result.reason,
		};
	}
}
