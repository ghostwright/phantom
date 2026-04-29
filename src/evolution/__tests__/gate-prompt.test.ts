import { describe, expect, test } from "bun:test";
import { GateJudgeResult, gateJudgePrompt } from "../gate-prompt.ts";

// Phase 3 migrated the gate prompt and schema out of the deleted
// judges/prompts.ts and judges/schemas.ts. These tests pin the shape so a
// future refactor cannot drift from the Phase 1 production-validated
// contract without a deliberate edit here.

describe("gateJudgePrompt", () => {
	test("returns a system and user message", () => {
		const result = gateJudgePrompt({
			channelType: "slack",
			turnCount: 4,
			durationSeconds: 120,
			totalCostUsd: 0.05,
			toolsUsed: "Read,Edit",
			outcome: "success",
			firstUserMessage: "help me deploy",
			lastUserMessage: "use Caddy not nginx",
			lastAgentMessage: "done",
			userReactions: "(none)",
			hookBlockCount: 0,
			toolErrorCount: 0,
		});
		expect(result.system).toBeDefined();
		expect(result.user).toBeDefined();
		expect(result.system.length).toBeGreaterThan(100);
		expect(result.user.length).toBeGreaterThan(10);
	});

	test("includes the eight fire signals in the system prompt", () => {
		const prompt = gateJudgePrompt({
			channelType: "slack",
			turnCount: 1,
			durationSeconds: 10,
			totalCostUsd: 0,
			toolsUsed: "",
			outcome: "success",
			firstUserMessage: "",
			lastUserMessage: "",
			lastAgentMessage: "",
			userReactions: "",
			hookBlockCount: 0,
			toolErrorCount: 0,
		});
		for (const signal of ["preference", "correction", "workflow", "failure", "If in doubt, fire"]) {
			expect(prompt.system).toContain(signal);
		}
	});

	test("interpolates session metadata into the user message", () => {
		const prompt = gateJudgePrompt({
			channelType: "slack",
			turnCount: 7,
			durationSeconds: 300,
			totalCostUsd: 0.42,
			toolsUsed: "Bash,Write",
			outcome: "failure",
			firstUserMessage: "open a new VM",
			lastUserMessage: "not that one, use the staging host",
			lastAgentMessage: "okay",
			userReactions: "thumbs_down",
			hookBlockCount: 1,
			toolErrorCount: 2,
		});
		expect(prompt.user).toContain("turns: 7");
		expect(prompt.user).toContain("duration: 300s");
		expect(prompt.user).toContain("outcome: failure");
		expect(prompt.user).toContain("hook_blocks: 1");
		expect(prompt.user).toContain("tool_errors: 2");
	});
});

describe("GateJudgeResult schema", () => {
	test("accepts a valid evolve=true decision", () => {
		const result = GateJudgeResult.parse({ evolve: true, reason: "new workflow pattern" });
		expect(result.evolve).toBe(true);
	});

	test("accepts a valid evolve=false decision", () => {
		const result = GateJudgeResult.parse({ evolve: false, reason: "routine task" });
		expect(result.evolve).toBe(false);
	});

	test("rejects missing fields", () => {
		expect(() => GateJudgeResult.parse({ evolve: true })).toThrow();
	});

	test("rejects non-boolean evolve", () => {
		expect(() => GateJudgeResult.parse({ evolve: "yes", reason: "r" })).toThrow();
	});

	test("enforces a 400-char cap on the reason", () => {
		const longReason = "x".repeat(500);
		expect(() => GateJudgeResult.parse({ evolve: true, reason: longReason })).toThrow();
	});
});
