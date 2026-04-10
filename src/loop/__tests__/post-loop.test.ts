import { describe, expect, test } from "bun:test";
import { type LoopTranscript, synthesizeSessionData } from "../post-loop.ts";
import type { Loop } from "../types.ts";

function makeLoop(overrides: Partial<Loop> = {}): Loop {
	return {
		id: "loop-123",
		goal: "Refactor the auth module",
		workspaceDir: "/tmp/ws",
		stateFile: "/tmp/ws/state.md",
		successCommand: null,
		maxIterations: 20,
		maxCostUsd: 5,
		maxTickDurationMs: 30 * 60 * 1000,
		checkpointInterval: null,
		status: "running",
		iterationCount: 5,
		totalCostUsd: 1.23,
		channelId: null,
		conversationId: null,
		statusMessageTs: null,
		triggerMessageTs: null,
		interruptRequested: false,
		lastError: null,
		startedAt: "2024-01-01T00:00:00Z",
		lastTickAt: "2024-01-01T00:05:00Z",
		finishedAt: "2024-01-01T00:06:00Z",
		...overrides,
	};
}

function makeTranscript(overrides: Partial<LoopTranscript> = {}): LoopTranscript {
	return {
		firstPrompt: "First tick prompt",
		firstResponse: "First tick response",
		summaries: ["Tick 2: in-progress", "Tick 3: in-progress"],
		lastPrompt: "Last tick prompt",
		lastResponse: "Last tick response",
		...overrides,
	};
}

describe("synthesizeSessionData", () => {
	test("maps done status to success outcome", () => {
		const data = synthesizeSessionData(makeLoop(), "done", makeTranscript());
		expect(data.outcome).toBe("success");
	});

	test("maps stopped status to abandoned outcome", () => {
		const data = synthesizeSessionData(makeLoop(), "stopped", makeTranscript());
		expect(data.outcome).toBe("abandoned");
	});

	test("maps budget_exceeded status to failure outcome", () => {
		const data = synthesizeSessionData(makeLoop(), "budget_exceeded", makeTranscript());
		expect(data.outcome).toBe("failure");
	});

	test("maps failed status to failure outcome", () => {
		const data = synthesizeSessionData(makeLoop(), "failed", makeTranscript());
		expect(data.outcome).toBe("failure");
	});

	test("includes context header with tick count and goal", () => {
		const data = synthesizeSessionData(makeLoop(), "done", makeTranscript());
		expect(data.userMessages[0]).toContain("[Loop: 5 ticks");
		expect(data.userMessages[0]).toContain("Refactor the auth module");
		expect(data.userMessages[0]).toContain("outcome: success");
	});

	test("includes first tick prompt, rolling summaries, and last tick prompt", () => {
		const data = synthesizeSessionData(makeLoop(), "done", makeTranscript());
		expect(data.userMessages[0]).toContain("First tick prompt");
		expect(data.userMessages).toContain("Tick 2: in-progress");
		expect(data.userMessages).toContain("Tick 3: in-progress");
		expect(data.userMessages[data.userMessages.length - 1]).toContain("Last tick prompt");
	});

	test("includes first and last assistant responses", () => {
		const data = synthesizeSessionData(makeLoop(), "done", makeTranscript());
		expect(data.assistantMessages).toHaveLength(2);
		expect(data.assistantMessages[0]).toContain("First tick response");
		expect(data.assistantMessages[1]).toContain("Last tick response");
	});

	test("uses channel:channelId for Slack-originated loops", () => {
		const loop = makeLoop({ channelId: "C100" });
		const data = synthesizeSessionData(loop, "done", makeTranscript());
		expect(data.userId).toBe("channel:C100");
	});

	test("uses 'autonomous' for headless loops", () => {
		const loop = makeLoop({ channelId: null });
		const data = synthesizeSessionData(loop, "done", makeTranscript());
		expect(data.userId).toBe("autonomous");
	});

	test("session key uses channel:conversation for Slack loops", () => {
		const loop = makeLoop({ channelId: "C100", conversationId: "1700000.000" });
		const data = synthesizeSessionData(loop, "done", makeTranscript());
		expect(data.sessionKey).toBe("C100:1700000.000");
	});

	test("session key uses loop:id for headless loops", () => {
		const loop = makeLoop({ channelId: null });
		const data = synthesizeSessionData(loop, "done", makeTranscript());
		expect(data.sessionKey).toBe("loop:loop-123");
	});

	test("passes through cost and timestamps", () => {
		const data = synthesizeSessionData(makeLoop(), "done", makeTranscript());
		expect(data.costUsd).toBe(1.23);
		expect(data.startedAt).toBe("2024-01-01T00:00:00Z");
		expect(data.endedAt).toBe("2024-01-01T00:06:00Z");
	});

	test("uses empty arrays for toolsUsed and filesTracked", () => {
		const data = synthesizeSessionData(makeLoop(), "done", makeTranscript());
		expect(data.toolsUsed).toEqual([]);
		expect(data.filesTracked).toEqual([]);
	});

	test("handles empty transcript (no-tick loop)", () => {
		const transcript = makeTranscript({ summaries: [] });
		const data = synthesizeSessionData(makeLoop({ iterationCount: 0 }), "stopped", transcript);
		expect(data.userMessages.length).toBeGreaterThan(0);
		expect(data.outcome).toBe("abandoned");
	});
});
