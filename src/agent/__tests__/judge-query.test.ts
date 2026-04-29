import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { __absorbUsageForTest, buildSystemPrompt, parseJsonFromResponse } from "../judge-query.ts";

// parseJsonFromResponse is the shape-normalization layer for judge subprocess output.
// Models sometimes return markdown fences, leading prose, or trailing whitespace even
// when asked for raw JSON. These tests lock in the tolerance window: we accept the
// well-formed common cases and reject anything that cannot be safely parsed.

const Schema = z.object({
	verdict: z.enum(["pass", "fail"]),
	confidence: z.number().min(0).max(1),
	reasoning: z.string(),
});

describe("parseJsonFromResponse", () => {
	test("parses raw JSON object", () => {
		const text = '{"verdict":"pass","confidence":0.95,"reasoning":"Looks clean."}';
		const result = parseJsonFromResponse(text, Schema);
		expect(result.verdict).toBe("pass");
		expect(result.confidence).toBe(0.95);
	});

	test("parses JSON wrapped in markdown json code fence", () => {
		const text = '```json\n{"verdict":"fail","confidence":0.8,"reasoning":"Issue detected."}\n```';
		const result = parseJsonFromResponse(text, Schema);
		expect(result.verdict).toBe("fail");
		expect(result.reasoning).toBe("Issue detected.");
	});

	test("parses JSON wrapped in plain markdown code fence", () => {
		const text = '```\n{"verdict":"pass","confidence":1,"reasoning":"ok"}\n```';
		const result = parseJsonFromResponse(text, Schema);
		expect(result.verdict).toBe("pass");
	});

	test("handles leading/trailing whitespace", () => {
		const text = '\n\n  {"verdict":"pass","confidence":0.5,"reasoning":"fine"}  \n';
		const result = parseJsonFromResponse(text, Schema);
		expect(result.verdict).toBe("pass");
	});

	test("recovers JSON from surrounding prose via brace scan", () => {
		const text = 'Here is my analysis: {"verdict":"fail","confidence":0.72,"reasoning":"Unsafe pattern"}. Thank you.';
		const result = parseJsonFromResponse(text, Schema);
		expect(result.verdict).toBe("fail");
		expect(result.confidence).toBe(0.72);
	});

	test("throws a clear error on empty response", () => {
		expect(() => parseJsonFromResponse("", Schema)).toThrow(/empty/i);
		expect(() => parseJsonFromResponse("   \n\n  ", Schema)).toThrow(/empty/i);
	});

	test("throws on text with no JSON object at all", () => {
		expect(() => parseJsonFromResponse("I cannot comply with this request.", Schema)).toThrow(/non-JSON|invalid/i);
	});

	test("throws on malformed JSON", () => {
		const text = '{"verdict":"pass", "confidence":';
		expect(() => parseJsonFromResponse(text, Schema)).toThrow(/invalid JSON|non-JSON/i);
	});

	test("throws on JSON that violates the schema", () => {
		const text = '{"verdict":"maybe","confidence":0.9,"reasoning":"..."}';
		expect(() => parseJsonFromResponse(text, Schema)).toThrow(/schema validation/i);
	});

	test("throws on JSON missing required fields", () => {
		const text = '{"verdict":"pass"}';
		expect(() => parseJsonFromResponse(text, Schema)).toThrow(/schema validation/i);
	});

	test("throws on confidence out of range", () => {
		const text = '{"verdict":"pass","confidence":1.5,"reasoning":"over"}';
		expect(() => parseJsonFromResponse(text, Schema)).toThrow(/schema validation/i);
	});

	test("error message includes truncated response for debugging", () => {
		const text = "not json at all, just prose with no object";
		expect(() => parseJsonFromResponse(text, Schema)).toThrow(/not json/i);
	});

	test("absorbUsage accumulates tokens from assistant BetaMessage envelope", () => {
		// The SDK's assistant message carries usage nested under `message.usage`.
		const messages = [{ type: "assistant", message: { usage: { input_tokens: 1200, output_tokens: 340 } } }];
		const partial = __absorbUsageForTest(messages);
		expect(partial.inputTokens).toBe(1200);
		expect(partial.outputTokens).toBe(340);
	});

	test("absorbUsage accumulates tokens from a top-level usage-bearing message", () => {
		// Some SDK message subtypes (system, task_*) surface usage on the top-
		// level object rather than on a nested `message` field.
		const messages = [
			{ type: "system_init", usage: { input_tokens: 75, output_tokens: 0 } },
			{ type: "task_progress", usage: { input_tokens: 50, output_tokens: 10 } },
		];
		const partial = __absorbUsageForTest(messages);
		expect(partial.inputTokens).toBe(125);
		expect(partial.outputTokens).toBe(10);
	});

	test("absorbUsage tolerates a missing result frame at the end of a stream", () => {
		// This is the SIGKILL shape: an assistant message with usage followed
		// by an abrupt end of stream. The partial cost keeps whatever tokens
		// flowed through, and the upstream caller raises `JudgeSubprocessError`
		// with these numbers attached.
		const messages = [
			{ type: "assistant", message: { usage: { input_tokens: 900, output_tokens: 0 } } },
			{ type: "assistant", message: { usage: { input_tokens: 110, output_tokens: 22 } } },
			// no { type: "result" } frame
		];
		const partial = __absorbUsageForTest(messages);
		expect(partial.inputTokens).toBe(1010);
		expect(partial.outputTokens).toBe(22);
		expect(partial.costUsd).toBe(0);
	});

	test("buildSystemPrompt returns the claude_code preset envelope by default", () => {
		const prompt = buildSystemPrompt("evaluate this", false);
		expect(typeof prompt).toBe("object");
		if (typeof prompt === "object") {
			expect(prompt.type).toBe("preset");
			expect(prompt.preset).toBe("claude_code");
			expect(prompt.append).toBe("evaluate this");
		}
	});

	test("buildSystemPrompt returns a plain string when omitPreset is true", () => {
		// This is the C3 fix shape: the SDK accepts a plain-string systemPrompt
		// per its docstring ("Use a custom system prompt") and that path skips
		// the preset's base prompt and full tool catalog. The gate is the only
		// caller that flips this on, because it is a pure pass/skip evaluation
		// with no tool use. Other judges keep the preset.
		const prompt = buildSystemPrompt("evaluate this", true);
		expect(typeof prompt).toBe("string");
		expect(prompt).toBe("evaluate this");
	});

	test("parses nested structures", () => {
		const Nested = z.object({
			flags: z.array(z.object({ category: z.string(), severity: z.enum(["critical", "warning", "info"]) })),
			verdict: z.enum(["pass", "fail"]),
		});
		const text = '```json\n{"flags":[{"category":"safety","severity":"critical"}],"verdict":"fail"}\n```';
		const result = parseJsonFromResponse(text, Nested);
		expect(result.flags).toHaveLength(1);
		expect(result.flags[0].severity).toBe("critical");
		expect(result.verdict).toBe("fail");
	});
});
