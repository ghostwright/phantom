import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../db/migrate.ts";
import { LoopRunner } from "../runner.ts";

type HandleMessageImpl = (
	channel: string,
	conversationId: string,
	text: string,
) => Promise<{
	text: string;
	sessionId: string;
	cost: { totalUsd: number; inputTokens: number; outputTokens: number; modelUsage: Record<string, never> };
	durationMs: number;
}>;

function createMockRuntime(impl?: HandleMessageImpl) {
	const defaultImpl: HandleMessageImpl = async () => ({
		text: "ok",
		sessionId: "s",
		cost: { totalUsd: 0.01, inputTokens: 10, outputTokens: 10, modelUsage: {} },
		durationMs: 10,
	});
	return {
		handleMessage: mock(impl ?? defaultImpl),
	};
}

// Mock handleMessage that updates the state file to mark the loop done on first tick.
function agentFinishes(stateFile: string, loopId: string): HandleMessageImpl {
	return async () => {
		writeFileSync(stateFile, `---\nloop_id: ${loopId}\nstatus: done\niteration: 1\n---\n\nDone.\n`, "utf-8");
		return {
			text: "done",
			sessionId: "s",
			cost: { totalUsd: 0.01, inputTokens: 1, outputTokens: 1, modelUsage: {} },
			durationMs: 1,
		};
	};
}

describe("LoopRunner", () => {
	let db: Database;
	let dataDir: string;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA foreign_keys = ON");
		runMigrations(db);
		dataDir = mkdtempSync(join(tmpdir(), "phantom-loop-test-"));
	});

	afterEach(() => {
		db.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("start creates a loop row and initializes state file", () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });

		const loop = runner.start({ goal: "Write a haiku" });

		expect(loop.id).toBeTruthy();
		expect(loop.status).toBe("running");
		expect(loop.iterationCount).toBe(0);
		expect(loop.maxIterations).toBe(20);
		expect(loop.maxCostUsd).toBe(5);
		expect(loop.workspaceDir).toContain(dataDir);

		const state = readFileSync(loop.stateFile, "utf-8");
		expect(state).toContain(`loop_id: ${loop.id}`);
		expect(state).toContain("Write a haiku");
	});

	test("start clamps max_iterations to hard ceiling", () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		const loop = runner.start({ goal: "x", maxIterations: 10_000 });
		expect(loop.maxIterations).toBe(200);
	});

	test("start throws when workspace escapes the data dir", () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		expect(() => runner.start({ goal: "evil", workspace: "../evil" })).toThrow(/escapes data dir/);
	});

	test("start clamps max_cost_usd to hard ceiling", () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		const loop = runner.start({ goal: "x", maxCostUsd: 9999 });
		expect(loop.maxCostUsd).toBe(50);
	});

	test("tick invokes runtime with loop channel and rotating conversation ids", async () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		const loop = runner.start({ goal: "Do the thing" });

		runtime.handleMessage.mockImplementation(agentFinishes(loop.stateFile, loop.id));

		await runner.tick(loop.id);

		const final = runner.getLoop(loop.id);
		expect(final?.status).toBe("done");
		expect(final?.iterationCount).toBe(1);
		expect(runtime.handleMessage).toHaveBeenCalledTimes(1);

		// Verify channel + conversation id shape used for the SDK call
		const call = runtime.handleMessage.mock.calls[0];
		expect(call[0]).toBe("loop");
		expect(call[1]).toBe(`${loop.id}:0`);
	});

	test("conversation id rotates across ticks to force fresh sessions", async () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		const loop = runner.start({ goal: "Rotate ids", maxIterations: 3 });

		await runner.tick(loop.id);
		await runner.tick(loop.id);
		await runner.tick(loop.id);

		const calls = runtime.handleMessage.mock.calls;
		expect(calls.length).toBe(3);
		expect(calls[0][1]).toBe(`${loop.id}:0`);
		expect(calls[1][1]).toBe(`${loop.id}:1`);
		expect(calls[2][1]).toBe(`${loop.id}:2`);
	});

	test("budget: loop is finalized as budget_exceeded when iteration cap reached", async () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		const loop = runner.start({ goal: "Never finishes", maxIterations: 3 });

		await runner.tick(loop.id);
		await runner.tick(loop.id);
		await runner.tick(loop.id);
		// Fourth tick should detect the budget and finalize without invoking the runtime.
		await runner.tick(loop.id);

		const final = runner.getLoop(loop.id);
		expect(final?.status).toBe("budget_exceeded");
		expect(final?.iterationCount).toBe(3);
		expect(runtime.handleMessage).toHaveBeenCalledTimes(3);
	});

	test("budget: loop is finalized as budget_exceeded when cost cap reached", async () => {
		const runtime = createMockRuntime(async () => ({
			text: "expensive",
			sessionId: "s",
			cost: { totalUsd: 0.6, inputTokens: 1, outputTokens: 1, modelUsage: {} },
			durationMs: 1,
		}));
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		const loop = runner.start({ goal: "Spend money", maxIterations: 100, maxCostUsd: 1.0 });

		// Tick 1: spends 0.60 (under 1.00) - another tick allowed
		// Tick 2: spends 0.60 more, total 1.20 (over 1.00)
		// Tick 3: budget check sees totalCostUsd >= maxCostUsd, finalizes
		await runner.tick(loop.id);
		await runner.tick(loop.id);
		await runner.tick(loop.id);

		const final = runner.getLoop(loop.id);
		expect(final?.status).toBe("budget_exceeded");
		expect(final?.totalCostUsd).toBeGreaterThanOrEqual(1.0);
	});

	test("tick is a no-op when loop already finished", async () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		const loop = runner.start({ goal: "done already" });

		runtime.handleMessage.mockImplementation(agentFinishes(loop.stateFile, loop.id));
		await runner.tick(loop.id);
		expect(runner.getLoop(loop.id)?.status).toBe("done");

		await runner.tick(loop.id);
		expect(runtime.handleMessage).toHaveBeenCalledTimes(1);
	});

	test("requestStop + tick finalizes the loop as stopped without invoking runtime", async () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		const loop = runner.start({ goal: "Keep going", maxIterations: 100 });

		const ok = runner.requestStop(loop.id);
		expect(ok).toBe(true);

		await runner.tick(loop.id);

		expect(runner.getLoop(loop.id)?.status).toBe("stopped");
		expect(runtime.handleMessage).not.toHaveBeenCalled();
	});

	test("requestStop returns false for non-running loops", async () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		const loop = runner.start({ goal: "x" });

		runtime.handleMessage.mockImplementation(agentFinishes(loop.stateFile, loop.id));
		await runner.tick(loop.id);

		expect(runner.requestStop(loop.id)).toBe(false);
	});

	test("list(false) returns only running loops; list(true) includes finished", async () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });

		const a = runner.start({ goal: "A", maxIterations: 1 });
		await runner.tick(a.id);
		await runner.tick(a.id); // budget check finalizes
		expect(runner.getLoop(a.id)?.status).toBe("budget_exceeded");

		const b = runner.start({ goal: "B", maxIterations: 100 });

		expect(runner.list(false).map((l) => l.id)).toEqual([b.id]);
		const all = runner
			.list(true)
			.map((l) => l.id)
			.sort();
		expect(all).toContain(a.id);
		expect(all).toContain(b.id);
	});

	test("resumeRunning returns count of loops that were still running", () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });

		runner.start({ goal: "Survive" });
		runner.start({ goal: "Also survive" });

		// Fresh runner on the same db, as if the process restarted.
		const runner2 = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		expect(runner2.resumeRunning()).toBe(2);
	});

	test("after resume, the next tick re-reads state and continues from current iteration", async () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		const loop = runner.start({ goal: "Resume me" });

		// Simulate one tick before "restart"
		runtime.handleMessage.mockImplementation(async () => {
			// agent wrote some progress but hasn't finished
			writeFileSync(
				loop.stateFile,
				`---\nloop_id: ${loop.id}\nstatus: in-progress\niteration: 1\n---\n\nHalfway there.\n`,
				"utf-8",
			);
			return {
				text: "progress",
				sessionId: "s",
				cost: { totalUsd: 0.01, inputTokens: 1, outputTokens: 1, modelUsage: {} },
				durationMs: 1,
			};
		});
		await runner.tick(loop.id);

		// Restart: fresh runner, state file is source of truth.
		const runner2 = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		runtime.handleMessage.mockImplementation(agentFinishes(loop.stateFile, loop.id));
		await runner2.tick(loop.id);

		expect(runner2.getLoop(loop.id)?.status).toBe("done");
	});

	test("success_command exit 0 terminates loop as done", async () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		const loop = runner.start({ goal: "Check", maxIterations: 10, successCommand: "true" });

		await runner.tick(loop.id);

		expect(runner.getLoop(loop.id)?.status).toBe("done");
	});

	test("autoSchedule: true drives ticks until the state file marks done", async () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: true });
		const loop = runner.start({ goal: "auto" });
		runtime.handleMessage.mockImplementation(agentFinishes(loop.stateFile, loop.id));

		// Poll up to ~1s (50 * 20ms). Generous for shared CI VMs.
		let reached = false;
		for (let i = 0; i < 50; i++) {
			if (runner.getLoop(loop.id)?.status === "done") {
				reached = true;
				break;
			}
			await Bun.sleep(20);
		}
		expect(reached).toBe(true); // loop did not reach done within 1s
		expect(runtime.handleMessage).toHaveBeenCalled();
	});

	test("success_command exit non-zero does not terminate the loop", async () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime: runtime, dataDir, autoSchedule: false });
		const loop = runner.start({ goal: "No success", maxIterations: 3, successCommand: "false" });

		await runner.tick(loop.id);
		expect(runner.getLoop(loop.id)?.status).toBe("running");
	});
});
