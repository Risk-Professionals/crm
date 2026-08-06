import { Injectable } from "@nestjs/common";
import { GraphClient, type GraphResult } from "./graph.client";
import { type GraphDeltaPage, type GraphRecipient } from "./mail.client";
import { GRAPH_BASE_URL } from "./microsoft.constants";

export type GraphEventDateTime = {
	dateTime?: string;
	timeZone?: string;
};

export type GraphEvent = {
	id: string;
	iCalUId?: string;
	seriesMasterId?: string;
	type?: string;
	subject?: string;
	bodyPreview?: string;
	body?: { contentType?: string; content?: string };
	location?: { displayName?: string };
	onlineMeeting?: { joinUrl?: string };
	onlineMeetingUrl?: string;
	start?: GraphEventDateTime;
	end?: GraphEventDateTime;
	isAllDay?: boolean;
	isCancelled?: boolean;
	organizer?: GraphRecipient;
	attendees?: Array<
		GraphRecipient & {
			status?: { response?: string };
			type?: string;
		}
	>;
	webLink?: string;
	"@removed"?: { reason?: string };
};

@Injectable()
export class MicrosoftCalendarClient {
	constructor(private readonly graph: GraphClient) {}

	delta(
		accessToken: string,
		options: {
			windowStart: Date;
			windowEnd: Date;
			cursor?: string | null;
			calendarId?: string | null;
		},
	): Promise<GraphResult<GraphDeltaPage<GraphEvent>>> {
		const cursor = options.cursor?.trim();
		const calendarPath = options.calendarId
			? `/me/calendars/${encodeURIComponent(options.calendarId)}`
			: "/me";

		return this.graph.get(
			cursor || `${GRAPH_BASE_URL}${calendarPath}/calendarView/delta`,
			accessToken,
			{
				prefer: ['IdType="ImmutableId"', 'outlook.timezone="UTC"'],
				...(cursor
					? {}
					: {
							params: {
								startDateTime: options.windowStart.toISOString(),
								endDateTime: options.windowEnd.toISOString(),
							},
						}),
			},
		);
	}
}
