import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EvolutionEngine } from "../engine.ts";
import { type QueryRunner, __setReflectionRunnerForTest } from "../reflection-subprocess.ts";
import type { SessionSummary } from "../types.ts";

// Phase 3 engine tests. The engine no longer owns the heuristic pipeline;
// it calls the reflection subprocess once per drain and commits or skips
// based on the sentinel + invariant check. The runner override lets us
// simulate subprocess behaviour deterministically without spawning the
// real Agent SDK.

const TEST_DIR = "/tmp/phantom-test-engine";
const CONFIG_PATH = `${TEST_DIR}/config/evolution.yaml`;

function setupTestEnvironment(): void {
	mkdirSync(`${TEST_DIR}/config`, { recursive: true });
	mkdirSync(`${TEST_DIR}/phantom-config/meta`, { recursive: true });
	mkdirSync(`${TEST_DIR}/phantom-config/strategies`, { recursive: true });
	mkdirSync(`${TEST_DIR}/phantom-config/memory`, { recursive: true });

	writeFileSync(
		CONFIG_PATH,
		[
			"reflection:",
			'  enabled: "always"',
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

	writeFileSync(
		`${TEST_DIR}/phantom-config/constitution.md`,
		["# Phantom Constitution", "", "1. Honesty.", "2. Safety.", "3. Privacy."].join("\n"),
		"utf-8",
	);
	writeFileSync(`${TEST_DIR}/phantom-config/persona.md`, "# Persona\n\n- Be direct.\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/user-profile.md`, "# User Profile\n\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/domain-knowledge.md`, "# Domain Knowledge\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/strategies/task-patterns.md`, "# Task Patterns\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/strategies/tool-preferences.md`, "# Tool Preferences\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/strategies/error-recovery.md`, "# Error Recovery\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/memory/session-log.jsonl`, "", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/memory/principles.md`, "# Principles\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/memory/corrections.md`, "# Corrections\n", "utf-8");

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
	writeFileSync(
		`${TEST_DIR}/phantom-config/meta/metrics.json`,
		JSON.stringify({
			session_count: 0,
			success_count: 0,
			failure_count: 0,
			evolution_count: 0,
			last_session_at: null,
			last_evolution_at: null,
			success_rate_7d: 0,
		}),
		"utf-8",
	);
	writeFileSync(`${TEST_DIR}/phantom-config/meta/evolution-log.jsonl`, "", "utf-8");
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		session_id: "session-001",
		session_key: "cli:main",
		user_id: "user-1",
		user_messages: ["Help me set up a TypeScript project"],
		assistant_messages: ["Sure."],
		tools_used: [],
		files_tracked: [],
		outcome: "success",
		cost_usd: 0.05,
		started_at: "2026-03-25T10:00:00Z",
		ended_at: "2026-03-25T10:05:00Z",
		...overrides,
	};
}

function runnerThatWrites(text: string): QueryRunner {
	return async () => {
		// Simulate the subprocess writing a bullet to user-profile.md.
		const path = `${TEST_DIR}/phantom-config/user-profile.md`;
		const current = readFileSync(path, "utf-8");
		writeFileSync(path, `${current}- ${text}\n`, "utf-8");
		return {
			responseText: `${text}\n{"status":"ok","changes":[{"file":"user-profile.md","action":"edit","summary":"${text}"}]}`,
			costUsd: 0.001,
			inputTokens: 100,
			outputTokens: 20,
			timedOut: false,
			sigkilled: false,
			error: null,
		};
	};
}

function runnerThatSkips(): QueryRunner {
	return async () => ({
		responseText: '{"status":"skip","reason":"no new signal"}',
		costUsd: 0.0005,
		inputTokens: 80,
		outputTokens: 10,
		timedOut: false,
		sigkilled: false,
		error: null,
	});
}

describe("EvolutionEngine", () => {
	beforeEach(() => {
		setupTestEnvironment();
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		__setReflectionRunnerForTest(null);
	});

	test("initializes and reads config", () => {
		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.getCurrentVersion()).toBe(0);
	});

	test("getConfig returns all evolved config sections", () => {
		const engine = new EvolutionEngine(CONFIG_PATH);
		const config = engine.getConfig();
		expect(config.constitution).toContain("Honesty");
		expect(config.persona).toContain("Be direct");
		expect(config.userProfile).toContain("User Profile");
		expect(config.meta.version).toBe(0);
	});

	test("afterSession skip path leaves version unchanged", async () => {
		__setReflectionRunnerForTest(runnerThatSkips());
		const engine = new EvolutionEngine(CONFIG_PATH);
		const result = await engine.afterSession(makeSession({ user_messages: ["What time is it?"] }));
		expect(result.changes_applied).toHaveLength(0);
		expect(engine.getCurrentVersion()).toBe(0);
	});

	test("afterSession write path bumps version and appends evolution log", async () => {
		__setReflectionRunnerForTest(runnerThatWrites("prefers typescript strict mode"));
		const engine = new EvolutionEngine(CONFIG_PATH);
		const result = await engine.afterSession(makeSession({ user_messages: ["No, use TypeScript not JavaScript"] }));
		expect(result.changes_applied.length).toBeGreaterThan(0);
		expect(engine.getCurrentVersion()).toBe(1);
		const log = readFileSync(`${TEST_DIR}/phantom-config/meta/evolution-log.jsonl`, "utf-8").trim();
		const entry = JSON.parse(log);
		expect(entry.changes_applied).toBeGreaterThan(0);
		expect(entry.version).toBe(1);
	});

	test("afterSession updates session metrics once per session_key", async () => {
		__setReflectionRunnerForTest(runnerThatSkips());
		const engine = new EvolutionEngine(CONFIG_PATH);
		await engine.afterSession(makeSession({ outcome: "success" }));
		await engine.afterSession(makeSession({ outcome: "success" }));
		const metrics = engine.getMetrics();
		expect(metrics.session_count).toBe(1);
		expect(metrics.success_count).toBe(1);
	});

	test("setOnConfigApplied fires after a successful afterSession that applies changes", async () => {
		__setReflectionRunnerForTest(runnerThatWrites("something"));
		const engine = new EvolutionEngine(CONFIG_PATH);
		const versions: number[] = [];
		engine.setOnConfigApplied(() => {
			versions.push(engine.getCurrentVersion());
		});
		await engine.afterSession(makeSession({ user_messages: ["No, use TypeScript"] }));
		expect(versions.length).toBeGreaterThanOrEqual(1);
		expect(versions.at(-1)).toBe(engine.getCurrentVersion());
	});

	test("setOnConfigApplied does not fire on a skip drain", async () => {
		__setReflectionRunnerForTest(runnerThatSkips());
		const engine = new EvolutionEngine(CONFIG_PATH);
		let calls = 0;
		engine.setOnConfigApplied(() => {
			calls += 1;
		});
		await engine.afterSession(makeSession({ user_messages: ["Hello"] }));
		expect(calls).toBe(0);
	});

	test("setOnConfigApplied callback errors do not wedge the pipeline", async () => {
		__setReflectionRunnerForTest(runnerThatWrites("something"));
		const engine = new EvolutionEngine(CONFIG_PATH);
		engine.setOnConfigApplied(() => {
			throw new Error("simulated runtime refresh failure");
		});
		const result = await engine.afterSession(makeSession({ user_messages: ["No, use TypeScript"] }));
		expect(result.changes_applied.length).toBeGreaterThan(0);
		expect(result.version).toBeGreaterThan(0);
	});

	test("evolved config is available in getConfig after changes", async () => {
		__setReflectionRunnerForTest(runnerThatWrites("prefers TypeScript"));
		const engine = new EvolutionEngine(CONFIG_PATH);
		await engine.afterSession(makeSession({ user_messages: ["No, use TypeScript"] }));
		const config = engine.getConfig();
		expect(config.userProfile).toContain("TypeScript");
		expect(config.meta.version).toBeGreaterThan(0);
	});

	test("reflection.enabled never short-circuits runDrainPipeline before spawn", async () => {
		// CRIT-1 regression guard. With reflection.enabled:"never", the engine
		// must NOT call the SDK runner. We override the config file in place
		// so the constructor reads "never" instead of the default "always".
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

		let runnerCalls = 0;
		const trackingRunner: QueryRunner = async () => {
			runnerCalls += 1;
			return {
				responseText: '{"status":"ok"}',
				costUsd: 0.001,
				inputTokens: 0,
				outputTokens: 0,
				timedOut: false,
				sigkilled: false,
				error: null,
			};
		};
		__setReflectionRunnerForTest(trackingRunner);

		const engine = new EvolutionEngine(CONFIG_PATH);
		const queued = {
			id: 1,
			session_id: "s1",
			session_key: "cli:disabled",
			gate_decision: { fire: true, source: "failsafe" as const, reason: "test", haiku_cost_usd: 0 },
			session_summary: makeSession({ session_id: "s1", session_key: "cli:disabled" }),
			enqueued_at: "2026-04-14T10:00:00Z",
			retry_count: 0,
		};
		const result = await engine.runDrainPipeline([queued]);

		expect(runnerCalls).toBe(0);
		expect(result.status).toBe("skip");
		expect(result.changes).toHaveLength(0);
		// session_count must still tick so the dedup set keeps working.
		expect(engine.getMetrics().session_count).toBe(1);
		// reflection_stats must reflect the disabled-mode drain so operators
		// can see it in metrics rather than wonder why nothing is happening.
		const metrics = JSON.parse(readFileSync(`${TEST_DIR}/phantom-config/meta/metrics.json`, "utf-8"));
		expect(metrics.reflection_stats.drains).toBe(1);
		expect(metrics.reflection_stats.status_skip).toBe(1);
	});
});
