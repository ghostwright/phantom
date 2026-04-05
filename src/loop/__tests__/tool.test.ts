import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../db/migrate.ts";
import { LoopRunner } from "../runner.ts";
import { createLoopToolServer } from "../tool.ts";

function mockRuntime() {
	return {
		handleMessage: mock(async () => ({
			text: "ok",
			sessionId: "s",
			cost: { totalUsd: 0.01, inputTokens: 1, outputTokens: 1, modelUsage: {} },
			durationMs: 1,
		})),
	};
}

// The MCP SDK wraps tool definitions inside createSdkMcpServer. To exercise the
// tool handlers directly we reach into the server instance that the factory
// returns. The shape is internal to the SDK, so we type it loosely and only
// read the fields we need for assertions.
type LoopHandler = (
	input: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: true }>;

function getLoopToolHandler(server: ReturnType<typeof createLoopToolServer>): LoopHandler {
	const instance = (server as unknown as { instance: { _registeredTools: Record<string, { handler: LoopHandler }> } })
		.instance;
	const registered = instance._registeredTools;
	const name = Object.keys(registered)[0];
	return registered[name].handler;
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
		runner = new LoopRunner({ db, runtime: mockRuntime() as never, dataDir, autoSchedule: false });
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
});
