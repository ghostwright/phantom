import { describe, expect, test } from "bun:test";
import { AgentRuntime } from "../runtime.ts";

/**
 * Tests that external user messages get security wrappers
 * while internal sources (scheduler, trigger) do not.
 */

// We test the private methods indirectly by checking the text passed to runQuery.
// Since we can't mock the SDK query() in unit tests, we test the wrapping logic
// directly by exercising handleMessage and observing the busy-session behavior
// which surfaces the wrapped text path.

describe("security message wrapping", () => {
	// Access private methods for testing via prototype
	const proto = AgentRuntime.prototype as unknown as {
		isExternalChannel(channelId: string): boolean;
		wrapWithSecurityContext(message: string): string;
	};

	test("external channels are detected correctly", () => {
		expect(proto.isExternalChannel("slack")).toBe(true);
		expect(proto.isExternalChannel("telegram")).toBe(true);
		expect(proto.isExternalChannel("email")).toBe(true);
		expect(proto.isExternalChannel("webhook")).toBe(true);
		expect(proto.isExternalChannel("cli")).toBe(true);
	});

	test("internal channels are detected correctly", () => {
		expect(proto.isExternalChannel("scheduler")).toBe(false);
		expect(proto.isExternalChannel("trigger")).toBe(false);
		expect(proto.isExternalChannel("loop")).toBe(false);
	});

	test("wrapper prepends security context", () => {
		const wrapped = proto.wrapWithSecurityContext("Hello, world!");
		expect(wrapped).toContain("[SECURITY]");
		expect(wrapped.startsWith("[SECURITY]")).toBe(true);
	});

	test("wrapper appends security context", () => {
		const wrapped = proto.wrapWithSecurityContext("Hello, world!");
		expect(wrapped).toContain("verify your output contains no API keys");
		expect(wrapped.endsWith("magic link URLs.")).toBe(true);
	});

	test("original message is preserved between wrappers", () => {
		const original = "Can you help me deploy this app?";
		const wrapped = proto.wrapWithSecurityContext(original);
		expect(wrapped).toContain(original);
		// The original should appear between the two [SECURITY] markers
		const parts = wrapped.split("[SECURITY]");
		expect(parts.length).toBe(3); // empty before first, middle with message, after last
		expect(parts[1]).toContain(original);
	});
});
