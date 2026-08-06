import { Injectable } from "@nestjs/common";
import { GraphClient, type GraphResult } from "./graph.client";
import { GRAPH_BASE_URL } from "./microsoft.constants";

export const MAIL_FOLDERS = ["inbox", "sentitems"] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

export type GraphEmailAddress = {
	name?: string;
	address?: string;
};

export type GraphRecipient = {
	emailAddress?: GraphEmailAddress;
};

export type GraphMessage = {
	id: string;
	conversationId?: string;
	internetMessageId?: string;
	parentFolderId?: string;
	subject?: string;
	bodyPreview?: string;
	body?: { contentType?: string; content?: string };
	from?: GraphRecipient;
	toRecipients?: GraphRecipient[];
	ccRecipients?: GraphRecipient[];
	sentDateTime?: string;
	receivedDateTime?: string;
	isDraft?: boolean;
	webLink?: string;
	"@removed"?: { reason?: string };
};

export type GraphMailFolder = {
	id: string;
	displayName?: string;
};

export type GraphDeltaPage<T> = {
	value: T[];
	"@odata.nextLink"?: string;
	"@odata.deltaLink"?: string;
};

const MESSAGE_FIELDS = [
	"id",
	"internetMessageId",
	"conversationId",
	"parentFolderId",
	"subject",
	"bodyPreview",
	"body",
	"from",
	"toRecipients",
	"ccRecipients",
	"sentDateTime",
	"receivedDateTime",
	"isDraft",
	"webLink",
].join(",");

@Injectable()
export class MicrosoftMailClient {
	constructor(private readonly graph: GraphClient) {}

	folder(
		accessToken: string,
		folder: MailFolder,
	): Promise<GraphResult<GraphMailFolder>> {
		return this.graph.get(
			`${GRAPH_BASE_URL}/me/mailFolders/${folder}`,
			accessToken,
			{ params: { $select: "id,displayName" } },
		);
	}

	delta(
		accessToken: string,
		options: { folderId: string; cursor?: string | null },
	): Promise<GraphResult<GraphDeltaPage<GraphMessage>>> {
		const cursor = options.cursor?.trim();
		return this.graph.get(
			cursor ||
				`${GRAPH_BASE_URL}/me/mailFolders/${encodeURIComponent(options.folderId)}/messages/delta`,
			accessToken,
			{
				prefer: ['IdType="ImmutableId"', 'outlook.body-content-type="text"'],
				...(cursor ? {} : { params: { $select: MESSAGE_FIELDS, $top: 50 } }),
			},
		);
	}
}
