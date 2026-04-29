import { describe, expect, test } from "bun:test";
import { JUDGE_MODEL_HAIKU, JUDGE_MODEL_OPUS, JUDGE_MODEL_SONNET } from "../judge-models.ts";

// Pin the model constants so a well-meaning edit cannot silently change
// what the gate or the reflection subprocess actually runs on. Updating a
// model id should be a deliberate one-line PR with a known smoke window.

describe("judge-models constants", () => {
	test("JUDGE_MODEL_HAIKU is the expected Haiku id", () => {
		expect(JUDGE_MODEL_HAIKU).toBe("claude-haiku-4-5");
	});

	test("JUDGE_MODEL_SONNET is the expected Sonnet id", () => {
		expect(JUDGE_MODEL_SONNET).toBe("claude-sonnet-4-6");
	});

	test("JUDGE_MODEL_OPUS is the expected Opus id", () => {
		expect(JUDGE_MODEL_OPUS).toBe("claude-opus-4-7");
	});

	test("all three tiers resolve to distinct ids", () => {
		const set = new Set([JUDGE_MODEL_HAIKU, JUDGE_MODEL_SONNET, JUDGE_MODEL_OPUS]);
		expect(set.size).toBe(3);
	});
});
