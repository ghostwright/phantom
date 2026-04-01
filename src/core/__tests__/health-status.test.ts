import { describe, expect, test } from "bun:test";
import type { MemoryHealth } from "../../memory/types.ts";

/**
 * Extract the health status logic from server.ts for isolated testing.
 * This must mirror the logic in startServer's /health handler exactly.
 */
function computeHealthStatus(memory: MemoryHealth): string {
	return memory.clawmem ? "ok" : memory.configured ? "down" : "ok";
}

describe("health status logic", () => {
	test("clawmem healthy and configured -> ok", () => {
		expect(computeHealthStatus({ clawmem: true, configured: true })).toBe("ok");
	});

	test("clawmem down when configured -> down", () => {
		expect(computeHealthStatus({ clawmem: false, configured: true })).toBe("down");
	});

	test("clawmem down when not configured -> ok", () => {
		expect(computeHealthStatus({ clawmem: false, configured: false })).toBe("ok");
	});
});
