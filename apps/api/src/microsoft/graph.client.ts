import { Injectable, Logger } from "@nestjs/common";
import { GRAPH_HOSTNAME } from "./microsoft.constants";

export type GraphResult<T> =
	| { outcome: "ok"; data: T }
	| { outcome: "cursor-invalid"; reason: string }
	| { outcome: "unauthorized"; reason: string }
	| { outcome: "rate-limited"; reason: string; retryAfterMs: number }
	| { outcome: "failed"; reason: string; retryable: boolean };

export type GraphRequestOptions = {
	params?: Record<string, string | number | boolean | undefined>;
	prefer?: readonly string[];
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

@Injectable()
export class GraphClient {
	private readonly logger = new Logger(GraphClient.name);

	async get<T>(
		url: string,
		accessToken: string,
		options: GraphRequestOptions = {},
	): Promise<GraphResult<T>> {
		const target = this.target(url);
		if (!target) {
			return {
				outcome: "failed",
				reason: "Refused a Microsoft Graph URL outside graph.microsoft.com.",
				retryable: false,
			};
		}

		for (const [key, value] of Object.entries(options.params ?? {})) {
			if (value !== undefined) target.searchParams.set(key, String(value));
		}

		const headers = new Headers({ authorization: `Bearer ${accessToken}` });
		if (options.prefer?.length) {
			headers.set("prefer", options.prefer.join(", "));
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

		try {
			const response = await fetch(target, {
				headers,
				signal: controller.signal,
			});

			return await this.interpret<T>(response, target.pathname);
		} catch (error) {
			const aborted = error instanceof Error && error.name === "AbortError";
			return {
				outcome: "failed",
				reason: aborted
					? `Timed out after ${DEFAULT_TIMEOUT_MS}ms.`
					: error instanceof Error
						? error.message
						: String(error),
				retryable: true,
			};
		} finally {
			clearTimeout(timeout);
		}
	}

	private target(url: string): URL | null {
		try {
			const target = new URL(url);
			return target.protocol === "https:" && target.hostname === GRAPH_HOSTNAME
				? target
				: null;
		} catch {
			return null;
		}
	}

	private async interpret<T>(
		response: Response,
		path: string,
	): Promise<GraphResult<T>> {
		if (response.ok) {
			return { outcome: "ok", data: (await response.json()) as T };
		}

		const detail = await this.reason(response);

		switch (response.status) {
			case 401:
			case 403:
				return { outcome: "unauthorized", reason: detail };
			case 410:
				return { outcome: "cursor-invalid", reason: detail };
			case 429:
				return {
					outcome: "rate-limited",
					reason: detail,
					retryAfterMs: this.backoffFrom(response),
				};
			default: {
				const retryable = response.status >= 500;
				this.logger.warn({
					message: "Microsoft Graph call failed",
					path,
					status: response.status,
					retryable,
				});
				return { outcome: "failed", reason: detail, retryable };
			}
		}
	}

	private backoffFrom(response: Response): number {
		const value = response.headers.get("retry-after");
		if (!value) return DEFAULT_BACKOFF_MS;

		const seconds = Number(value);
		const suggested = Number.isFinite(seconds)
			? seconds * 1000
			: Date.parse(value) - Date.now();

		if (!Number.isFinite(suggested)) return DEFAULT_BACKOFF_MS;
		return Math.min(Math.max(suggested, 1000), MAX_BACKOFF_MS);
	}

	private async reason(response: Response): Promise<string> {
		try {
			const body = (await response.json()) as {
				error?: { code?: string; message?: string };
			};
			return (
				body.error?.message ?? body.error?.code ?? `HTTP ${response.status}`
			);
		} catch {
			return `HTTP ${response.status}`;
		}
	}
}
