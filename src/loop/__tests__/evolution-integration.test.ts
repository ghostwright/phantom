import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../db/migrate.ts";
import { LoopRunner } from "../runner.ts";
import { LoopStartInputSchema } from "../types.ts";

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
		releaseSession: mock(() => {}),
	};
}

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

describe("LoopRunner evolution integration", () => {
	let db: Database;
	let dataDir: string;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA foreign_keys = ON");
		runMigrations(db);
		dataDir = mkdtempSync(join(tmpdir(), "phantom-loop-evo-"));
	});

	afterEach(() => {
		db.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	test("memory context is cached once at start and reused across ticks", async () => {
		const buildMock = mock(async () => "## Known Facts\n- User prefers TS");
		const mockContextBuilder = { build: buildMock } as never;

		const runtime = createMockRuntime();
		const runner = new LoopRunner({
			db,
			runtime,
			dataDir,
			autoSchedule: false,
			memoryContextBuilder: mockContextBuilder,
		});
		const loop = runner.start({ goal: "Test memory caching", maxIterations: 5 });

		// Allow the async cache to resolve
		await Bun.sleep(10);

		// buildMock called once at start
		expect(buildMock).toHaveBeenCalledTimes(1);
		expect(buildMock).toHaveBeenCalledWith("Test memory caching");

		// Tick multiple times - build should still only be called once
		await runner.tick(loop.id);
		await runner.tick(loop.id);
		expect(buildMock).toHaveBeenCalledTimes(1);

		// Verify the prompt contains memory context
		const promptArg = runtime.handleMessage.mock.calls[0][2] as string;
		expect(promptArg).toContain("RECALLED MEMORIES");
		expect(promptArg).toContain("User prefers TS");
	});

	test("memory context is cleared on finalize", async () => {
		const buildMock = mock(async () => "some context");
		const mockContextBuilder = { build: buildMock } as never;

		const runtime = createMockRuntime();
		const runner = new LoopRunner({
			db,
			runtime,
			dataDir,
			autoSchedule: false,
			memoryContextBuilder: mockContextBuilder,
		});
		const loop = runner.start({ goal: "clean up", maxIterations: 1 });
		await Bun.sleep(10);

		runtime.handleMessage.mockImplementation(agentFinishes(loop.stateFile, loop.id));
		await runner.tick(loop.id);

		expect(runner.getLoop(loop.id)?.status).toBe("done");

		// Start another loop - build should be called again (cache was cleared)
		runner.start({ goal: "another" });
		await Bun.sleep(10);
		expect(buildMock).toHaveBeenCalledTimes(2);
	});

	test("post-loop evolution is called on finalize with correct session data", async () => {
		const afterSessionMock = mock(async () => ({ version: 1, changes_applied: [], changes_rejected: [] }));
		const mockEvolution = {
			afterSession: afterSessionMock,
			getConfig: () => ({ userProfile: "", domainKnowledge: "" }),
		};
		const mockMemory = { isReady: () => false };
		const onUpdate = mock(() => {});

		const runtime = createMockRuntime();
		const runner = new LoopRunner({
			db,
			runtime,
			dataDir,
			autoSchedule: false,
			postLoopDeps: {
				evolution: mockEvolution as never,
				memory: mockMemory as never,
				onEvolvedConfigUpdate: onUpdate,
			},
		});
		const loop = runner.start({ goal: "evolve this" });
		runtime.handleMessage.mockImplementation(agentFinishes(loop.stateFile, loop.id));
		await runner.tick(loop.id);

		// Allow fire-and-forget to complete
		await Bun.sleep(50);

		expect(afterSessionMock).toHaveBeenCalledTimes(1);
		const summary = (afterSessionMock.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
		expect(summary.session_id).toBe(loop.id);
		expect(summary.outcome).toBe("success");
	});

	test("post-loop evolution failure does not affect loop status", async () => {
		const mockEvolution = {
			afterSession: mock(async () => {
				throw new Error("evolution broke");
			}),
			getConfig: () => ({ userProfile: "", domainKnowledge: "" }),
		};
		const mockMemory = { isReady: () => false };

		const runtime = createMockRuntime();
		const runner = new LoopRunner({
			db,
			runtime,
			dataDir,
			autoSchedule: false,
			postLoopDeps: {
				evolution: mockEvolution as never,
				memory: mockMemory as never,
				onEvolvedConfigUpdate: () => {},
			},
		});
		const loop = runner.start({ goal: "survive evolution failure" });
		runtime.handleMessage.mockImplementation(agentFinishes(loop.stateFile, loop.id));
		await runner.tick(loop.id);

		await Bun.sleep(50);

		// Loop should still be done, not failed
		expect(runner.getLoop(loop.id)?.status).toBe("done");
	});

	test("critique does NOT fire when postLoopDeps is absent", async () => {
		const runtime = createMockRuntime();
		// No postLoopDeps = no evolution engine = critique should never fire
		const runner = new LoopRunner({
			db,
			runtime,
			dataDir,
			autoSchedule: false,
		});
		const loop = runner.start({ goal: "no evolution", checkpointInterval: 1 });

		await runner.tick(loop.id);

		// The prompt should NOT contain reviewer feedback (critique skipped)
		const promptArg = runtime.handleMessage.mock.calls[0][2] as string;
		expect(promptArg).not.toContain("REVIEWER FEEDBACK");
	});

	test("critique does NOT fire when usesLLMJudges returns false", async () => {
		const mockEvolution = {
			afterSession: mock(async () => ({ version: 1, changes_applied: [], changes_rejected: [] })),
			getConfig: () => ({ userProfile: "", domainKnowledge: "" }),
			usesLLMJudges: () => false,
			isWithinCostCap: () => true,
			trackExternalJudgeCost: mock(() => {}),
		};

		const runtime = createMockRuntime();
		const runner = new LoopRunner({
			db,
			runtime,
			dataDir,
			autoSchedule: false,
			postLoopDeps: {
				evolution: mockEvolution as never,
				memory: { isReady: () => false } as never,
				onEvolvedConfigUpdate: () => {},
			},
		});
		const loop = runner.start({ goal: "judges disabled", checkpointInterval: 1 });

		await runner.tick(loop.id);
		await runner.tick(loop.id);

		// Second tick prompt should NOT have critique (judges disabled)
		const secondPrompt = runtime.handleMessage.mock.calls[1][2] as string;
		expect(secondPrompt).not.toContain("REVIEWER FEEDBACK");
		expect(mockEvolution.trackExternalJudgeCost).not.toHaveBeenCalled();
	});

	test("critique does NOT fire when cost cap is exceeded", async () => {
		const mockEvolution = {
			afterSession: mock(async () => ({ version: 1, changes_applied: [], changes_rejected: [] })),
			getConfig: () => ({ userProfile: "", domainKnowledge: "" }),
			usesLLMJudges: () => true,
			isWithinCostCap: () => false,
			trackExternalJudgeCost: mock(() => {}),
		};

		const runtime = createMockRuntime();
		const runner = new LoopRunner({
			db,
			runtime,
			dataDir,
			autoSchedule: false,
			postLoopDeps: {
				evolution: mockEvolution as never,
				memory: { isReady: () => false } as never,
				onEvolvedConfigUpdate: () => {},
			},
		});
		const loop = runner.start({ goal: "over budget", checkpointInterval: 1 });

		await runner.tick(loop.id);
		await runner.tick(loop.id);

		const secondPrompt = runtime.handleMessage.mock.calls[1][2] as string;
		expect(secondPrompt).not.toContain("REVIEWER FEEDBACK");
		expect(mockEvolution.trackExternalJudgeCost).not.toHaveBeenCalled();
	});

	test("tick 1 summary is recorded in transcript", async () => {
		const runtime = createMockRuntime();
		const afterSessionMock = mock(async () => ({ version: 1, changes_applied: [], changes_rejected: [] }));
		const runner = new LoopRunner({
			db,
			runtime,
			dataDir,
			autoSchedule: false,
			postLoopDeps: {
				evolution: {
					afterSession: afterSessionMock,
					getConfig: () => ({ userProfile: "", domainKnowledge: "" }),
					usesLLMJudges: () => false,
					isWithinCostCap: () => true,
					trackExternalJudgeCost: mock(() => {}),
				} as never,
				memory: { isReady: () => false } as never,
				onEvolvedConfigUpdate: () => {},
			},
		});
		const loop = runner.start({ goal: "check tick 1 summary" });

		runtime.handleMessage.mockImplementation(agentFinishes(loop.stateFile, loop.id));
		await runner.tick(loop.id);

		// Allow fire-and-forget to complete
		await Bun.sleep(50);

		// The session data should include a Tick 1 summary
		const summary = (afterSessionMock.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
		const userMsgs = summary.user_messages as string[];
		const hasTick1Summary = userMsgs.some((m) => m.includes("Tick 1:"));
		expect(hasTick1Summary).toBe(true);
	});

	test("checkpoint_interval round-trips through start/store", () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime, dataDir, autoSchedule: false });

		const loop = runner.start({ goal: "with checkpoint", checkpointInterval: 5 });
		expect(loop.checkpointInterval).toBe(5);

		const reloaded = runner.getLoop(loop.id);
		expect(reloaded?.checkpointInterval).toBe(5);
	});

	test("checkpoint_interval defaults to null when omitted", () => {
		const runtime = createMockRuntime();
		const runner = new LoopRunner({ db, runtime, dataDir, autoSchedule: false });

		const loop = runner.start({ goal: "no checkpoint" });
		expect(loop.checkpointInterval).toBeNull();
	});
});

describe("LoopStartInputSchema checkpoint_interval validation", () => {
	test("accepts valid checkpoint_interval", () => {
		const result = LoopStartInputSchema.safeParse({
			goal: "test",
			checkpoint_interval: 5,
		});
		expect(result.success).toBe(true);
	});

	test("accepts 0 (disabled)", () => {
		const result = LoopStartInputSchema.safeParse({
			goal: "test",
			checkpoint_interval: 0,
		});
		expect(result.success).toBe(true);
	});

	test("rejects negative values", () => {
		const result = LoopStartInputSchema.safeParse({
			goal: "test",
			checkpoint_interval: -1,
		});
		expect(result.success).toBe(false);
	});

	test("rejects values above ceiling", () => {
		const result = LoopStartInputSchema.safeParse({
			goal: "test",
			checkpoint_interval: 201,
		});
		expect(result.success).toBe(false);
	});

	test("rejects non-integer values", () => {
		const result = LoopStartInputSchema.safeParse({
			goal: "test",
			checkpoint_interval: 5.5,
		});
		expect(result.success).toBe(false);
	});

	test("accepts omitted (optional)", () => {
		const result = LoopStartInputSchema.safeParse({ goal: "test" });
		expect(result.success).toBe(true);
	});
});
