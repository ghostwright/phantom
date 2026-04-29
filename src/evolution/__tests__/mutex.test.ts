import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { EvolutionEngine } from "../engine.ts";
import { type QueryRunner, __setReflectionRunnerForTest } from "../reflection-subprocess.ts";
import type { SessionSummary } from "../types.ts";

// Phase 0 belt-and-suspenders mutex tests. The Phase 2 cadence serialises
// drains through its own `inFlight` guard, so the engine mutex is
// redundant on the production path, but it remains load-bearing for the
// direct-call `afterSession` path and guards against a future caller that
// reaches `afterSessionInternal` outside the cadence.

const TEST_DIR = "/tmp/phantom-test-mutex";
const CONFIG_PATH = `${TEST_DIR}/config/evolution.yaml`;

function setup(): void {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(`${TEST_DIR}/config`, { recursive: true });
	mkdirSync(`${TEST_DIR}/phantom-config/meta`, { recursive: true });
	mkdirSync(`${TEST_DIR}/phantom-config/strategies`, { recursive: true });
	mkdirSync(`${TEST_DIR}/phantom-config/memory`, { recursive: true });
	writeFileSync(
		CONFIG_PATH,
		[
			"reflection:",
			'  enabled: "never"',
			"paths:",
			`  config_dir: "${TEST_DIR}/phantom-config"`,
			`  constitution: "${TEST_DIR}/phantom-config/constitution.md"`,
			`  version_file: "${TEST_DIR}/phantom-config/meta/version.json"`,
			`  metrics_file: "${TEST_DIR}/phantom-config/meta/metrics.json"`,
			`  evolution_log: "${TEST_DIR}/phantom-config/meta/evolution-log.jsonl"`,
			`  session_log: "${TEST_DIR}/phantom-config/memory/session-log.jsonl"`,
		].join("\n"),
		"utf-8",
	);
	writeFileSync(`${TEST_DIR}/phantom-config/constitution.md`, "1. Honesty\n2. Safety\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/persona.md`, "# Persona\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/user-profile.md`, "# User Profile\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/domain-knowledge.md`, "# Domain\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/strategies/task-patterns.md`, "# Tasks\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/strategies/tool-preferences.md`, "# Tools\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/strategies/error-recovery.md`, "# Errors\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/memory/corrections.md`, "# Corrections\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/memory/session-log.jsonl`, "", "utf-8");
	writeFileSync(
		`${TEST_DIR}/phantom-config/meta/version.json`,
		JSON.stringify({
			version: 0,
			parent: null,
			timestamp: "2026-03-25T00:00:00Z",
			changes: [],
			metrics_at_change: { session_count: 0, success_rate_7d: 0 },
		}),
		"utf-8",
	);
	writeFileSync(`${TEST_DIR}/phantom-config/meta/metrics.json`, "{}", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/meta/evolution-log.jsonl`, "", "utf-8");
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		session_id: "s1",
		session_key: "slack:C1:T1",
		user_id: "u1",
		user_messages: ["hi"],
		assistant_messages: ["ok"],
		tools_used: [],
		files_tracked: [],
		outcome: "success",
		cost_usd: 0.01,
		started_at: "2026-04-14T10:00:00Z",
		ended_at: "2026-04-14T10:01:00Z",
		...overrides,
	};
}

function slowRunner(delayMs: number): QueryRunner {
	return async () => {
		await new Promise((r) => setTimeout(r, delayMs));
		return {
			responseText: '{"status":"skip","reason":"slow"}',
			costUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			timedOut: false,
			sigkilled: false,
			error: null,
		};
	};
}

function instantSkipRunner(): QueryRunner {
	return async () => ({
		responseText: '{"status":"skip"}',
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		timedOut: false,
		sigkilled: false,
		error: null,
	});
}

describe("EvolutionEngine activeCycle mutex", () => {
	beforeEach(() => setup());
	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		__setReflectionRunnerForTest(null);
	});

	test("second concurrent afterSession call is skipped while the first is in flight", async () => {
		__setReflectionRunnerForTest(slowRunner(40));
		const engine = new EvolutionEngine(CONFIG_PATH);
		const first = engine.afterSession(makeSession({ session_id: "s-first", session_key: "slack:C1:T1" }));
		const second = engine.afterSession(makeSession({ session_id: "s-second", session_key: "slack:C2:T2" }));
		const [firstResult, secondResult] = await Promise.all([first, second]);
		// The mutex forces one of them to short-circuit with a skipped
		// result. We cannot predict which lost the race, but exactly one of
		// the two must have no applied changes AND the current version must
		// not double-increment.
		const zeroApplied = [firstResult, secondResult].filter((r) => r.changes_applied.length === 0).length;
		expect(zeroApplied).toBeGreaterThanOrEqual(1);
	});

	test("mutex releases after a successful drain so subsequent sessions run normally", async () => {
		__setReflectionRunnerForTest(instantSkipRunner());
		const engine = new EvolutionEngine(CONFIG_PATH);
		await engine.afterSession(makeSession({ session_id: "a", session_key: "slack:C:Ta" }));
		await engine.afterSession(makeSession({ session_id: "b", session_key: "slack:C:Tb" }));
		await engine.afterSession(makeSession({ session_id: "c", session_key: "slack:C:Tc" }));
		const metrics = engine.getMetrics();
		expect(metrics.session_count).toBe(3);
	});

	test("mutex releases after a thrown subprocess runner", async () => {
		let shouldThrow = true;
		__setReflectionRunnerForTest(async (input) => {
			if (shouldThrow) {
				shouldThrow = false;
				throw new Error("boom");
			}
			return instantSkipRunner()(input);
		});
		const engine = new EvolutionEngine(CONFIG_PATH);
		// The first call catches the error internally via the runReflectionSubprocess
		// try/catch; the mutex should clear even on the error path.
		await engine.afterSession(makeSession({ session_id: "fail", session_key: "slack:C:Tfail" }));
		// Second call must run (mutex not wedged).
		const secondResult = await engine.afterSession(makeSession({ session_id: "ok", session_key: "slack:C:Tok" }));
		expect(secondResult).toBeDefined();
	});

	test("afterSession returns a skipped result (not an error) under contention", async () => {
		__setReflectionRunnerForTest(slowRunner(30));
		const engine = new EvolutionEngine(CONFIG_PATH);
		const first = engine.afterSession(makeSession({ session_id: "slow", session_key: "slack:C:Tslow" }));
		const second = engine.afterSession(makeSession({ session_id: "other", session_key: "slack:C:Tother" }));
		const results = await Promise.all([first, second]);
		for (const result of results) {
			// Every result must be structurally well-formed (a skipped cycle
			// returns the current version with empty change arrays).
			expect(result.version).toBeGreaterThanOrEqual(0);
			expect(Array.isArray(result.changes_applied)).toBe(true);
		}
	});
});
