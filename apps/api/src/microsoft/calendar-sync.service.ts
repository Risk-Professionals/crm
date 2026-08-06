import {
	ActivityType,
	type Db,
	type MailboxSyncModel as MailboxSync,
	type Prisma,
	RecordSource,
	SyncProvider,
} from "@crm/db";
import { Injectable, Logger } from "@nestjs/common";
import { AgentTriggerService } from "../agent/agent-trigger.service";
import { ActivityStampService } from "../crm/activity-stamp.service";
import { InjectDatabase } from "../database/database.constants";
import {
	GoogleMatchService,
	type MatchContext,
} from "../google/google-match.service";
import { isMachineAddress, type Participant } from "../google/participants";
import { type GraphEvent, MicrosoftCalendarClient } from "./calendar.client";
import { MicrosoftSyncStateService } from "./microsoft-sync-state.service";
import { MicrosoftTokenService } from "./microsoft-token.service";

const MAX_PAGES_PER_RUN = 5;
const HORIZON_DAYS = 180;
const REBASE_DAYS = 7;

export type MicrosoftCalendarOutcome = {
	resource: "calendar";
	userId: string;
	status: "synced" | "skipped" | "reconnect" | "rate-limited" | "failed";
	written?: number;
	removed?: number;
	reason?: string;
};

@Injectable()
export class MicrosoftCalendarSyncService {
	private readonly logger = new Logger(MicrosoftCalendarSyncService.name);

	constructor(
		@InjectDatabase() private readonly db: Db,
		private readonly calendar: MicrosoftCalendarClient,
		private readonly tokens: MicrosoftTokenService,
		private readonly match: GoogleMatchService,
		private readonly state: MicrosoftSyncStateService,
		private readonly stamp: ActivityStampService,
		private readonly agent: AgentTriggerService,
	) {}

	async sync(
		input: MailboxSync,
		owner: string | null = input.leaseOwner,
	): Promise<MicrosoftCalendarOutcome> {
		const token = await this.tokens.accessTokenFor(input.userId, "calendar");
		if (token.outcome === "not-connected") {
			await this.state.markIdle(input.id, {}, owner);
			return {
				resource: "calendar",
				userId: input.userId,
				status: "skipped",
				reason: token.reason,
			};
		}
		if (token.outcome === "needs-reconnect") {
			await this.state.markNeedsReconnect(input.id, token.reason, owner);
			return {
				resource: "calendar",
				userId: input.userId,
				status: "reconnect",
				reason: token.reason,
			};
		}
		if (token.outcome === "failed") {
			await this.state.markFailed(input.id, token.reason, owner);
			return {
				resource: "calendar",
				userId: input.userId,
				status: "failed",
				reason: token.reason,
			};
		}

		let row = input;
		if (this.shouldRebase(row)) row = await this.rebase(row, owner);
		const windowStart = row.windowStart;
		const windowEnd = row.windowEnd;
		if (!windowStart || !windowEnd) {
			await this.state.markFailed(
				row.id,
				"Microsoft calendar sync has no fixed window.",
				owner,
			);
			return {
				resource: "calendar",
				userId: row.userId,
				status: "failed",
				reason: "Missing calendar window.",
			};
		}

		const context = await this.matchContext();
		const generation = row.reconciliationStartedAt ?? new Date();
		let cursor = row.providerPageCursor ?? row.providerCursor;
		let written = 0;
		let removed = 0;

		for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
			const result = await this.calendar.delta(token.accessToken, {
				windowStart,
				windowEnd,
				cursor,
			});
			if (result.outcome === "cursor-invalid") {
				await this.state.beginReconciliation(row.id, result.reason, owner);
				return {
					resource: "calendar",
					userId: row.userId,
					status: "synced",
					reason:
						"Cursor reset; reconciliation will continue on the next pass.",
				};
			}
			if (result.outcome !== "ok") return this.failure(row, result, owner);
			await this.state.assertOwned(row.id, owner);

			for (const event of result.data.value) {
				const applied = await this.apply(
					row,
					generation,
					event,
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
					"Microsoft calendar delta returned no continuation link.",
					owner,
				);
				return {
					resource: "calendar",
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
				removed += await this.reconcileWindow(
					row,
					generation,
					windowStart,
					windowEnd,
					owner,
				);
				await this.state.finishReconciliation(row.id, owner);
			}
			this.logger.log({
				message: "Microsoft calendar delta complete",
				userId: row.userId,
				windowStart: windowStart.toISOString(),
				windowEnd: windowEnd.toISOString(),
				written,
				removed,
			});
			return {
				resource: "calendar",
				userId: row.userId,
				status: "synced",
				written,
				removed,
			};
		}

		return {
			resource: "calendar",
			userId: row.userId,
			status: "synced",
			written,
			removed,
			reason: "Page budget reached; continuing from the saved page cursor.",
		};
	}

	private shouldRebase(row: MailboxSync): boolean {
		if (
			row.providerPageCursor ||
			row.reconciliationStartedAt ||
			!row.windowStart
		)
			return false;
		return (
			Date.now() - row.windowStart.getTime() >=
			REBASE_DAYS * 24 * 60 * 60 * 1000
		);
	}

	private async rebase(
		row: MailboxSync,
		owner?: string | null,
	): Promise<MailboxSync> {
		const windowStart = new Date();
		const windowEnd = new Date(windowStart);
		windowEnd.setUTCDate(windowEnd.getUTCDate() + HORIZON_DAYS);
		const generation = new Date();
		await this.state.markIdle(
			row.id,
			{
				windowStart,
				windowEnd,
				providerCursor: null,
				providerPageCursor: null,
				reconciliationStartedAt: generation,
			},
			owner,
		);
		return this.db.mailboxSync.findUniqueOrThrow({ where: { id: row.id } });
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
		generation: Date,
		event: GraphEvent,
		context: MatchContext,
		owner: string | null,
	): Promise<"written" | "removed" | "ignored"> {
		return this.state.withBusinessWrite(row.id, owner, async (tx) => {
			if (!event.id) return "ignored";
			if (event["@removed"] || event.isCancelled)
				return this.remove(tx, row.userId, event.id);
			const start = this.date(event.start?.dateTime);
			const end = this.date(event.end?.dateTime);
			if (!start || !end) return "ignored";

			const existing = await tx.calendarEvent.findUnique({
				where: {
					syncedByUserId_provider_providerEventId: {
						syncedByUserId: row.userId,
						provider: SyncProvider.MICROSOFT,
						providerEventId: event.id,
					},
				},
				select: {
					id: true,
					companyId: true,
					contactId: true,
					originalStartTime: true,
				},
			});
			const participants = this.participantsOf(event);
			const declinedByUs = event.attendees?.some(
				(attendee) =>
					context.ourAddresses.has(
						attendee.emailAddress?.address?.toLowerCase() ?? "",
					) && attendee.status?.response?.toLowerCase() === "declined",
			);
			const matched = await this.match.resolve(
				{
					participants,
					allowCreate: row.autoCreate && !declinedByUs,
					source: RecordSource.CALENDAR,
					ownerId: row.userId,
				},
				context,
			);
			const companyId = matched.companyId ?? existing?.companyId ?? null;
			const contactId = matched.contactId ?? existing?.contactId ?? null;
			if (!existing && !companyId && !contactId) return "ignored";

			const rawICal = event.iCalUId?.trim() || event.id;
			const originalStart =
				existing?.originalStartTime ?? this.date(event.originalStart) ?? start;
			const organizer =
				event.organizer?.emailAddress?.address?.trim().toLowerCase() || null;
			const record = await tx.calendarEvent.upsert({
				where: {
					syncedByUserId_provider_providerEventId: {
						syncedByUserId: row.userId,
						provider: SyncProvider.MICROSOFT,
						providerEventId: event.id,
					},
				},
				create: {
					iCalUid: `${row.userId}:microsoft:${rawICal}`,
					originalStartTime: originalStart,
					recurringEventId: event.seriesMasterId ?? null,
					title: event.subject?.trim() || null,
					description:
						this.text(event.body?.content ?? event.bodyPreview ?? "") || null,
					location: event.location?.displayName?.trim() || null,
					conferenceUrl:
						event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl ?? null,
					startsAt: start,
					endsAt: end,
					isAllDay: event.isAllDay ?? false,
					status: event.isCancelled ? "cancelled" : "confirmed",
					organizerEmail: organizer,
					companyId,
					contactId,
					syncedByUserId: row.userId,
					provider: SyncProvider.MICROSOFT,
					providerEventId: event.id,
					providerWebUrl: event.webLink ?? null,
					providerSeenAt: generation,
				},
				update: {
					recurringEventId: event.seriesMasterId ?? null,
					title: event.subject?.trim() || null,
					description:
						this.text(event.body?.content ?? event.bodyPreview ?? "") || null,
					location: event.location?.displayName?.trim() || null,
					conferenceUrl:
						event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl ?? null,
					startsAt: start,
					endsAt: end,
					isAllDay: event.isAllDay ?? false,
					status: "confirmed",
					organizerEmail: organizer,
					companyId,
					contactId,
					providerWebUrl: event.webLink ?? null,
					providerSeenAt: generation,
				},
				select: { id: true },
			});
			await this.syncAttendees(tx, record.id, event);
			await this.prepareForMeeting(tx, record.id, start);
			await this.project(tx, record.id, row.userId, {
				title: event.subject?.trim() || "Meeting",
				startsAt: start,
				companyId,
				contactId,
				location: event.location?.displayName?.trim() || null,
			});
			return "written";
		});
	}

	private async remove(
		tx: Prisma.TransactionClient,
		userId: string,
		providerEventId: string,
	): Promise<"removed" | "ignored"> {
		const deleted = await tx.calendarEvent.deleteMany({
			where: {
				syncedByUserId: userId,
				provider: SyncProvider.MICROSOFT,
				providerEventId,
			},
		});
		if (deleted.count > 0) await this.stamp.recomputeAll(tx);
		return deleted.count > 0 ? "removed" : "ignored";
	}

	private async reconcileWindow(
		row: MailboxSync,
		generation: Date,
		windowStart: Date,
		windowEnd: Date,
		owner: string | null,
	): Promise<number> {
		return this.state.withBusinessWrite(row.id, owner, async (tx) => {
			const deleted = await tx.calendarEvent.deleteMany({
				where: {
					syncedByUserId: row.userId,
					provider: SyncProvider.MICROSOFT,
					startsAt: { gte: windowStart, lte: windowEnd },
					OR: [
						{ providerSeenAt: null },
						{ providerSeenAt: { lt: generation } },
					],
				},
			});
			if (deleted.count > 0) await this.stamp.recomputeAll(tx);
			return deleted.count;
		});
	}

	private async syncAttendees(
		tx: Prisma.TransactionClient,
		eventId: string,
		event: GraphEvent,
	): Promise<void> {
		const organizerEmail =
			event.organizer?.emailAddress?.address?.trim().toLowerCase() ?? null;
		const attendeeByEmail = new Map(
			(event.attendees ?? []).flatMap((attendee) => {
				const email = attendee.emailAddress?.address?.trim().toLowerCase();
				if (!email || attendee.type === "resource" || isMachineAddress(email))
					return [];
				return [
					[
						email,
						{
							email,
							name: attendee.emailAddress?.name?.trim() || null,
							responseStatus: attendee.status?.response ?? null,
							isOrganizer: email === organizerEmail,
						},
					] as const,
				];
			}),
		);
		if (
			organizerEmail &&
			!isMachineAddress(organizerEmail) &&
			!attendeeByEmail.has(organizerEmail)
		) {
			attendeeByEmail.set(organizerEmail, {
				email: organizerEmail,
				name: event.organizer?.emailAddress?.name?.trim() || null,
				responseStatus: null,
				isOrganizer: true,
			});
		}
		const attendees = [...attendeeByEmail.values()];
		const emails = attendees.map((attendee) => attendee.email);
		const contacts = emails.length
			? await tx.contact.findMany({
					where: { email: { in: emails } },
					select: { id: true, email: true },
				})
			: [];
		const contactByEmail = new Map(
			contacts.flatMap((contact) =>
				contact.email
					? [[contact.email.toLowerCase(), contact.id] as const]
					: [],
			),
		);
		await tx.calendarAttendee.deleteMany({
			where: {
				eventId,
				...(emails.length ? { email: { notIn: emails } } : {}),
			},
		});
		for (const attendee of attendees) {
			await tx.calendarAttendee.upsert({
				where: { eventId_email: { eventId, email: attendee.email } },
				create: {
					eventId,
					...attendee,
					contactId: contactByEmail.get(attendee.email) ?? null,
				},
				update: {
					name: attendee.name,
					responseStatus: attendee.responseStatus,
					isOrganizer: attendee.isOrganizer,
					contactId: contactByEmail.get(attendee.email) ?? null,
				},
			});
		}
	}

	private async prepareForMeeting(
		tx: Prisma.TransactionClient,
		eventId: string,
		startsAt: Date,
	): Promise<void> {
		const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		if (startsAt <= new Date() || startsAt > soon) return;
		const attendees = await tx.calendarAttendee.findMany({
			where: {
				eventId,
				contactId: { not: null },
				contact: { brief: { is: null } },
			},
			select: { contactId: true },
		});
		for (const attendee of attendees) {
			if (attendee.contactId)
				await this.agent.meetingSoon(attendee.contactId, startsAt);
		}
	}

	private async project(
		tx: Prisma.TransactionClient,
		calendarEventId: string,
		userId: string,
		summary: {
			title: string;
			startsAt: Date;
			companyId: string | null;
			contactId: string | null;
			location: string | null;
		},
	): Promise<void> {
		const activity = await tx.activity.upsert({
			where: { calendarEventId },
			create: {
				type: ActivityType.MEETING,
				subject: summary.title,
				body: summary.location ? `Location: ${summary.location}` : null,
				occurredAt: summary.startsAt,
				companyId: summary.companyId,
				contactId: summary.contactId,
				createdById: userId,
				calendarEventId,
				meta: { synced: true, source: "microsoft" },
			},
			update: {
				subject: summary.title,
				body: summary.location ? `Location: ${summary.location}` : null,
				occurredAt: summary.startsAt,
				companyId: summary.companyId,
				contactId: summary.contactId,
			},
			select: { createdAt: true },
		});
		await this.stamp.touch(
			{ companyId: summary.companyId, contactId: summary.contactId },
			activity.createdAt,
			tx,
		);
	}

	private participantsOf(event: GraphEvent): Participant[] {
		const people = (event.attendees ?? []).flatMap((attendee) => {
			const email = attendee.emailAddress?.address?.trim().toLowerCase();
			return email && attendee.type !== "resource"
				? [{ email, name: attendee.emailAddress?.name?.trim() || null }]
				: [];
		});
		const organizer = event.organizer?.emailAddress?.address
			?.trim()
			.toLowerCase();
		if (organizer)
			people.push({
				email: organizer,
				name: event.organizer?.emailAddress?.name?.trim() || null,
			});
		return people;
	}

	private date(value: string | undefined): Date | null {
		if (!value) return null;
		const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
		return Number.isNaN(date.getTime()) ? null : date;
	}

	private text(value: string): string {
		return value
			.replace(/<br\s*\/?\s*>/gi, "\n")
			.replace(/<\/p>/gi, "\n")
			.replace(/<[^>]+>/g, "")
			.replace(/&nbsp;/gi, " ")
			.replace(/&amp;/gi, "&")
			.trim();
	}

	private async failure(
		row: MailboxSync,
		result: { outcome: string; reason: string; retryAfterMs?: number },
		owner?: string | null,
	): Promise<MicrosoftCalendarOutcome> {
		if (result.outcome === "unauthorized") {
			await this.state.markNeedsReconnect(row.id, result.reason, owner);
			return {
				resource: "calendar",
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
				resource: "calendar",
				userId: row.userId,
				status: "rate-limited",
				reason: result.reason,
			};
		}
		await this.state.markFailed(row.id, result.reason, owner);
		return {
			resource: "calendar",
			userId: row.userId,
			status: "failed",
			reason: result.reason,
		};
	}
}
