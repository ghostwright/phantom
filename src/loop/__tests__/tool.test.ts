import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slackContextStore } from "../../agent/slack-context.ts";
import { runMigrations } from "../../db/migrate.ts";
import { LoopRunner } from "../runner.ts";
import { LOOP_TOOL_NAME, createLoopToolServer } from "../tool.ts";

function mockRuntime() {
	return {
		handleMessage: mock(async () => ({
			text: "ok",
			sessionId: "s",
			cost: {
				totalUsd: 0.01,
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				modelUsage: {},
			},
			durationMs: 1,
		})),
		releaseSession: mock(() => {}),
	};
}

// NOTE: _registeredTools is internal to @anthropic-ai/claude-agent-sdk.
// Verified against 0.2.77. If this breaks on SDK upgrade, check the SDK's
// tool() + createSdkMcpServer() implementation. Using LOOP_TOOL_NAME (not
// Object.keys()[0]) so a rename fails loudly here instead of silently.
type LoopHandler = (
	input: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: true }>;

function getLoopToolHandler(server: ReturnType<typeof createLoopToolServer>): LoopHandler {
	const instance = (server as unknown as { instance: { _registeredTools: Record<string, { handler: LoopHandler }> } })
		.instance;
	const registered = instance._registeredTools[LOOP_TOOL_NAME];
	if (!registered) throw new Error(`SDK internals changed: tool "${LOOP_TOOL_NAME}" not found in _registeredTools`);
	return registered.handler;
}

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: true }) {
	return JSON.parse(result.content[0].text);
}

describe("phantom_loop MCP tool", () => {
	let db: Database;
	let dataDir: string;
	let runner: LoopRunner;
	let handler: LoopHandler;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA foreign_keys = ON");
		runMigrations(db);
		dataDir = mkdtempSync(join(tmpdir(), "phantom-loop-tool-"));
		runner = new LoopRunner({ db, runtime: mockRuntime(), dataDir, autoSchedule: false });
		handler = getLoopToolHandler(createLoopToolServer(runner));
	});

	afterEach(() => {
		db.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("start action creates a loop and returns its id", async () => {
		const result = await handler({ action: "start", goal: "Do the thing" });
		expect(result.isError).toBeUndefined();
		const body = parseResult(result);
		expect(body.started).toBe(true);
		expect(body.loop.id).toBeTruthy();
		expect(body.loop.status).toBe("running");
		expect(body.loop.max_iterations).toBe(20);
	});

	test("start without goal returns error", async () => {
		const result = await handler({ action: "start" });
		expect(result.isError).toBe(true);
		expect(parseResult(result).error).toContain("goal");
	});

	test("status action returns loop data and frontmatter", async () => {
		const startResult = await handler({ action: "start", goal: "Inspect me" });
		const { loop } = parseResult(startResult);

		const statusResult = await handler({ action: "status", loop_id: loop.id });
		const body = parseResult(statusResult);
		expect(body.loop.id).toBe(loop.id);
		expect(body.frontmatter).toEqual({ loopId: loop.id, status: "in-progress", iteration: 0 });
		expect(body.state_excerpt).toContain("Inspect me");
	});

	test("status action with unknown id returns error", async () => {
		const result = await handler({ action: "status", loop_id: "nope" });
		expect(result.isError).toBe(true);
	});

	test("stop action sets interrupt flag on a running loop", async () => {
		const startResult = await handler({ action: "start", goal: "Will be stopped" });
		const { loop } = parseResult(startResult);

		const stopResult = await handler({ action: "stop", loop_id: loop.id });
		const body = parseResult(stopResult);
		expect(body.stop_requested).toBe(true);
	});

	test("list action returns active loops by default", async () => {
		await handler({ action: "start", goal: "A" });
		await handler({ action: "start", goal: "B" });

		const result = await handler({ action: "list" });
		const body = parseResult(result);
		expect(body.count).toBeGreaterThanOrEqual(2);
	});

	describe("slackContextStore fallback", () => {
		test("start fills channel/thread/trigger from context when args omitted", async () => {
			const result = await slackContextStore.run(
				{
					slackChannelId: "C42",
					slackThreadTs: "1700000000.000100",
					slackMessageTs: "1700000000.000200",
				},
				() => handler({ action: "start", goal: "from context" }),
			);
			const { loop } = parseResult(result);
			// triggerMessageTs is intentionally not exposed in serializeLoop,
			// so read back through the runner directly.
			const stored = runner.getLoop(loop.id);
			expect(stored?.channelId).toBe("C42");
			expect(stored?.conversationId).toBe("1700000000.000100");
			expect(stored?.triggerMessageTs).toBe("1700000000.000200");
		});

		test("explicit args override context", async () => {
			const result = await slackContextStore.run(
				{
					slackChannelId: "C_CTX",
					slackThreadTs: "1700000000.000100",
					slackMessageTs: "1700000000.000200",
				},
				() =>
					handler({
						action: "start",
						goal: "explicit wins",
						channel_id: "C_EXPLICIT",
						conversation_id: "1800000000.000100",
						trigger_message_ts: "1800000000.000200",
					}),
			);
			const { loop } = parseResult(result);
			const stored = runner.getLoop(loop.id);
			expect(stored?.channelId).toBe("C_EXPLICIT");
			expect(stored?.conversationId).toBe("1800000000.000100");
			expect(stored?.triggerMessageTs).toBe("1800000000.000200");
		});

		test("missing context leaves fields null without crashing", async () => {
			// No slackContextStore.run wrapper here.
			const result = await handler({ action: "start", goal: "no context" });
			const { loop } = parseResult(result);
			const stored = runner.getLoop(loop.id);
			expect(stored?.channelId).toBeNull();
			expect(stored?.conversationId).toBeNull();
			expect(stored?.triggerMessageTs).toBeNull();
		});

		test("serializeLoop does not expose triggerMessageTs to the agent", async () => {
			const result = await slackContextStore.run(
				{
					slackChannelId: "C42",
					slackThreadTs: "1700000000.000100",
					slackMessageTs: "1700000000.000200",
				},
				() => handler({ action: "start", goal: "hidden field" }),
			);
			const body = parseResult(result);
			expect(body.loop.trigger_message_ts).toBeUndefined();
			expect(body.loop.triggerMessageTs).toBeUndefined();
		});
	});
});
