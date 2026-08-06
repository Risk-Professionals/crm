import { MICROSOFT_GRAPH_SCOPES, MICROSOFT_PROVIDER_ID } from "@crm/auth";

export { MICROSOFT_GRAPH_SCOPES, MICROSOFT_PROVIDER_ID };

export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
export const GRAPH_HOSTNAME = "graph.microsoft.com";

export const MICROSOFT_RESOURCE_SCOPES = {
	calendar: "Calendars.Read",
	mail: "Mail.Read",
} as const;

export type MicrosoftResource = keyof typeof MICROSOFT_RESOURCE_SCOPES;
