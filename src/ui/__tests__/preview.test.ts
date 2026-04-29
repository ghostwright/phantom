import { afterEach, describe, expect, test } from "bun:test";
import { createPreviewToolServer } from "../preview.ts";
import { createPreviewSession, isValidSession, revokeAllSessions } from "../session.ts";

afterEach(() => {
	revokeAllSessions();
});

describe("createPreviewSession", () => {
	test("returns a token accepted by isValidSession", () => {
		const { sessionToken } = createPreviewSession();
		expect(typeof sessionToken).toBe("string");
		expect(sessionToken.length).toBeGreaterThan(20);
		expect(isValidSession(sessionToken)).toBe(true);
	});

	test("tokens are unique per call", () => {
		const a = createPreviewSession().sessionToken;
		const b = createPreviewSession().sessionToken;
		expect(a).not.toBe(b);
	});

	test("token expires after the 10 minute TTL", () => {
		const { sessionToken } = createPreviewSession();
		expect(isValidSession(sessionToken)).toBe(true);

		const originalNow = Date.now;
		try {
			// Eleven minutes later, the session should have expired.
			Date.now = () => originalNow() + 11 * 60 * 1000;
			expect(isValidSession(sessionToken)).toBe(false);
		} finally {
			Date.now = originalNow;
		}
	});
});

describe("createPreviewToolServer", () => {
	test("returns an SDK MCP server config with a name", () => {
		const server = createPreviewToolServer(3100);
		expect(server).toBeDefined();
		expect(server.type).toBe("sdk");
		expect(server.name).toBe("phantom-preview");
		expect(server.instance).toBeDefined();
	});

	test("each call returns a distinct instance (factory pattern)", () => {
		const a = createPreviewToolServer(3100);
		const b = createPreviewToolServer(3100);
		expect(a.instance).not.toBe(b.instance);
	});

	test("instance exposes the MCP connect() contract", () => {
		const server = createPreviewToolServer(3100);
		const inst = server.instance as unknown as { connect: unknown };
		expect(typeof inst.connect).toBe("function");
	});
});
