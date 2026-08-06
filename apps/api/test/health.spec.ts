import { describe, expect, it } from "bun:test";
import type { Db } from "@crm/db";
import { ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "../src/health/health.controller";

function controller(query: () => Promise<unknown>) {
	const db = {
		$queryRaw: query,
	} as unknown as Db;

	return new HealthController(db);
}

describe("health probes", () => {
	it("keeps liveness independent from the database", () => {
		expect(controller(async () => Promise.reject()).live()).toEqual({
			status: "ok",
		});
	});

	it("reports readiness after a database round trip", async () => {
		expect(await controller(async () => [{ one: 1 }]).ready()).toEqual({
			status: "ok",
			database: "up",
		});
	});

	it("returns unavailable when the database cannot be reached", async () => {
		expect(
			controller(async () => {
				throw new Error("database down");
			}).ready(),
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});
});
