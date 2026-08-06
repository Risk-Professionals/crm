import { z } from "zod";

export const setMicrosoftAutoCreateInput = z.object({
	source: z.enum(["mail", "calendar"]),
	enabled: z.boolean(),
});

export const syncThreadInput = z.object({ threadId: z.string().min(1) });
export const syncEventInput = z.object({ eventId: z.string().min(1) });
