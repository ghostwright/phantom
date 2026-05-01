import { describe, expect, test } from "bun:test";
import { isNoConversationFoundResult, sdkResultErrorText } from "../sdk-result-errors.ts";

describe("sdk result errors", () => {
	test("extracts text from non-success result errors", () => {
		expect(
			sdkResultErrorText({
				type: "result",
				subtype: "error_during_execution",
				errors: ["first", "second"],
			}),
		).toBe("first\nsecond");
	});

	test("detects stale conversation result frames", () => {
		expect(
			isNoConversationFoundResult({
				type: "result",
				subtype: "error_during_execution",
				errors: ["No conversation found for session sdk-session-123."],
			}),
		).toBe(true);
	});

	test("ignores success results and malformed errors", () => {
		expect(isNoConversationFoundResult({ type: "result", subtype: "success", errors: ["No conversation found"] })).toBe(
			false,
		);
		expect(sdkResultErrorText({ type: "result", subtype: "error_during_execution", errors: [42] })).toBe(null);
	});
});
