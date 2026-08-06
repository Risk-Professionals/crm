import { afterEach, describe, expect, it } from "bun:test";
import { GraphClient } from "../src/microsoft/graph.client";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function respond(
	status: number,
	body: unknown,
	headers?: Record<string, string>,
) {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json", ...headers },
		})) as unknown as typeof fetch;
}

describe("GraphClient", () => {
	it("sends bearer auth and repeatable Outlook preferences", async () => {
		let request: Request | null = null;
		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			request =
				input instanceof Request
					? new Request(input, init)
					: new Request(String(input), init);
			return Response.json({ value: [{ id: "message-1" }] });
		}) as unknown as typeof fetch;

		const result = await new GraphClient().get<{ value: { id: string }[] }>(
			"https://graph.microsoft.com/v1.0/me/messages",
			"secret-token",
			{
				prefer: ['IdType="ImmutableId"', 'outlook.timezone="UTC"'],
				params: { $top: 25 },
			},
		);

		expect(result).toEqual({
			outcome: "ok",
			data: { value: [{ id: "message-1" }] },
		});
		expect(request).not.toBeNull();
		const sent = request as unknown as Request;
		expect(sent.headers.get("authorization")).toBe("Bearer secret-token");
		expect(sent.headers.get("prefer")).toBe(
			'IdType="ImmutableId", outlook.timezone="UTC"',
		);
		expect(new URL(sent.url).searchParams.get("$top")).toBe("25");
	});

	it("refuses opaque links outside Microsoft Graph before sending a token", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return Response.json({});
		}) as unknown as typeof fetch;

		expect(
			await new GraphClient().get(
				"https://attacker.example/delta?token=opaque",
				"secret-token",
			),
		).toEqual({
			outcome: "failed",
			reason: "Refused a Microsoft Graph URL outside graph.microsoft.com.",
			retryable: false,
		});
		expect(called).toBe(false);
	});

	it("maps an expired delta cursor to an explicit reset outcome", async () => {
		respond(410, {
			error: { code: "syncStateNotFound", message: "The sync state expired." },
		});

		expect(
			await new GraphClient().get(
				"https://graph.microsoft.com/v1.0/me/messages/delta",
				"token",
			),
		).toEqual({
			outcome: "cursor-invalid",
			reason: "The sync state expired.",
		});
	});

	it("honours Retry-After on throttling", async () => {
		respond(429, { error: { message: "Slow down." } }, { "retry-after": "42" });

		expect(
			await new GraphClient().get(
				"https://graph.microsoft.com/v1.0/me/messages/delta",
				"token",
			),
		).toEqual({
			outcome: "rate-limited",
			reason: "Slow down.",
			retryAfterMs: 42_000,
		});
	});

	it("separates revoked consent from retryable service failures", async () => {
		respond(403, { error: { message: "Insufficient privileges." } });
		expect(
			await new GraphClient().get(
				"https://graph.microsoft.com/v1.0/me/messages/delta",
				"token",
			),
		).toEqual({
			outcome: "unauthorized",
			reason: "Insufficient privileges.",
		});

		respond(503, { error: { message: "Unavailable." } });
		expect(
			await new GraphClient().get(
				"https://graph.microsoft.com/v1.0/me/messages/delta",
				"token",
			),
		).toEqual({
			outcome: "failed",
			reason: "Unavailable.",
			retryable: true,
		});
	});
});
