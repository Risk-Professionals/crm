import { describe, expect, it } from "bun:test";
import { GET } from "../app/health/route";

describe("web health", () => {
	it("returns a shallow liveness response", async () => {
		const response = GET();

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});
});
