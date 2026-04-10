import { describe, expect, test } from "bun:test";
import { buildTickPrompt } from "../prompt.ts";
import type { Loop } from "../types.ts";

function makeLoop(overrides: Partial<Loop> = {}): Loop {
	return {
		id: "loop-1",
		goal: "Write a haiku",
		workspaceDir: "/tmp/ws",
		stateFile: "/tmp/ws/state.md",
		successCommand: null,
		maxIterations: 20,
		maxCostUsd: 5,
		maxTickDurationMs: 30 * 60 * 1000,
		checkpointInterval: null,
		status: "running",
		iterationCount: 3,
		totalCostUsd: 0.5,
		channelId: null,
		conversationId: null,
		statusMessageTs: null,
		triggerMessageTs: null,
		interruptRequested: false,
		lastError: null,
		startedAt: "2024-01-01T00:00:00Z",
		lastTickAt: null,
		finishedAt: null,
		...overrides,
	};
}

describe("buildTickPrompt", () => {
	test("returns base prompt without optional sections when no options provided", () => {
		const prompt = buildTickPrompt(makeLoop(), "state contents");
		expect(prompt).toContain("Write a haiku");
		expect(prompt).toContain("state contents");
		expect(prompt).not.toContain("RECALLED MEMORIES");
		expect(prompt).not.toContain("REVIEWER FEEDBACK");
	});

	test("injects memory context before state file section", () => {
		const memoryContext = "## Known Facts\n- User prefers TypeScript";
		const prompt = buildTickPrompt(makeLoop(), "state contents", { memoryContext });

		expect(prompt).toContain("RECALLED MEMORIES (from previous sessions)");
		expect(prompt).toContain("User prefers TypeScript");

		// Memory should appear before state file contents
		const memoryIdx = prompt.indexOf("RECALLED MEMORIES");
		const stateIdx = prompt.indexOf("CURRENT STATE FILE CONTENTS");
		expect(memoryIdx).toBeLessThan(stateIdx);
	});

	test("injects critique section", () => {
		const critique = "The loop appears stuck in a pattern.";
		const prompt = buildTickPrompt(makeLoop(), "state contents", { critique });

		expect(prompt).toContain("REVIEWER FEEDBACK (from your last checkpoint)");
		expect(prompt).toContain("stuck in a pattern");
	});

	test("injects both memory and critique when both provided", () => {
		const prompt = buildTickPrompt(makeLoop(), "state contents", {
			memoryContext: "Some facts",
			critique: "Some feedback",
		});

		expect(prompt).toContain("RECALLED MEMORIES");
		expect(prompt).toContain("REVIEWER FEEDBACK");

		// Memory should come before critique
		const memoryIdx = prompt.indexOf("RECALLED MEMORIES");
		const critiqueIdx = prompt.indexOf("REVIEWER FEEDBACK");
		expect(memoryIdx).toBeLessThan(critiqueIdx);
	});

	test("skips empty memory context", () => {
		const prompt = buildTickPrompt(makeLoop(), "state contents", { memoryContext: "" });
		expect(prompt).not.toContain("RECALLED MEMORIES");
	});

	test("skips empty critique", () => {
		const prompt = buildTickPrompt(makeLoop(), "state contents", { critique: "" });
		expect(prompt).not.toContain("REVIEWER FEEDBACK");
	});
});
