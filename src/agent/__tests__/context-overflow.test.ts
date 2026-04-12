import { describe, expect, test } from "bun:test";
import { isContextOverflowError } from "../runtime.ts";

describe("isContextOverflowError", () => {
	test("detects prompt too long error", () => {
		expect(isContextOverflowError("prompt is too long: reduce input")).toBe(true);
		expect(isContextOverflowError("This model's maximum context length is 200000 tokens")).toBe(true);
	});

	test("detects context_length_exceeded error code", () => {
		expect(isContextOverflowError("context_length_exceeded")).toBe(true);
		expect(isContextOverflowError('{"error":{"type":"context_length_exceeded"}}')).toBe(true);
	});

	test("detects input too long messages", () => {
		expect(isContextOverflowError("Input is too long for requested operation")).toBe(true);
	});

	test("detects reduce length hint", () => {
		expect(isContextOverflowError("Please reduce the length of the messages or completion")).toBe(true);
	});

	test("detects context window mentions", () => {
		expect(isContextOverflowError("exceeds the context window limit")).toBe(true);
	});

	test("is case-insensitive", () => {
		expect(isContextOverflowError("PROMPT IS TOO LONG")).toBe(true);
		expect(isContextOverflowError("Context Window Exceeded")).toBe(true);
	});

	test("does not flag unrelated errors", () => {
		expect(isContextOverflowError("No conversation found")).toBe(false);
		expect(isContextOverflowError("rate limit exceeded")).toBe(false);
		expect(isContextOverflowError("invalid api key")).toBe(false);
		expect(isContextOverflowError("network error: ECONNRESET")).toBe(false);
		expect(isContextOverflowError("authentication failed")).toBe(false);
	});

	test("returns false for empty string", () => {
		expect(isContextOverflowError("")).toBe(false);
	});
});
