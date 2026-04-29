import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { JudgeSubprocessError } from "../../agent/judge-query.ts";
import type { AgentRuntime } from "../../agent/runtime.ts";
import type { EvolutionConfig } from "../config.ts";
import type { GateDecision } from "../gate-types.ts";
import { appendGateLog, decideGate, emptyGateStats, recordGateDecision } from "../gate.ts";
import type { SessionSummary } from "../types.ts";

// Phase 1 gate tests. The gate is a single Haiku call plus a failsafe, so the
// test surface is small and targeted. We cover:
//  - Haiku happy path returning evolve=true
//  - Haiku happy path returning evolve=false
//  - Haiku parse failure triggers failsafe fire
//  - Haiku subprocess error triggers failsafe fire with partial cost captured
//  - The gate log jsonl append shape
//  - The metrics.json gate_stats counter shape
//  - Null runtime path hits failsafe (no runtime = no Haiku = default open)
//  - Zero-runtime observability: gate_stats counters increment correctly on
//    mixed decisions

const TEST_DIR = "/tmp/phantom-test-gate";

function setupEnv(): EvolutionConfig {
	mkdirSync(`${TEST_DIR}/phantom-config/meta`, { recursive: true });
	writeFileSync(`${TEST_DIR}/phantom-config/meta/metrics.json`, "{}", "utf-8");
	return {
		reflection: { enabled: "always" },
		paths: {
			config_dir: `${TEST_DIR}/phantom-config`,
			constitution: `${TEST_DIR}/phantom-config/constitution.md`,
			version_file: `${TEST_DIR}/phantom-config/meta/version.json`,
			metrics_file: `${TEST_DIR}/phantom-config/meta/metrics.json`,
			evolution_log: `${TEST_DIR}/phantom-config/meta/evolution-log.jsonl`,
			session_log: `${TEST_DIR}/phantom-config/memory/session-log.jsonl`,
		},
	};
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		session_id: "sess-1",
		session_key: "slack:C123:T456",
		user_id: "U1",
		user_messages: ["help me debug this thing"],
		assistant_messages: ["done"],
		tools_used: ["Read", "Edit"],
		files_tracked: [],
		outcome: "success",
		cost_usd: 0.15,
		started_at: "2026-04-14T10:00:00Z",
		ended_at: "2026-04-14T10:02:00Z",
		...overrides,
	};
}

type FakeRuntime = {
	judgeQuery: (options: {
		systemPrompt: string;
		userMessage: string;
		schema: unknown;
		model?: string;
		maxTokens?: number;
		omitPreset?: boolean;
	}) => Promise<unknown>;
};

describe("decideGate Haiku happy path", () => {
	beforeEach(() => setupEnv());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("evolve=true returns fire source=haiku with cost", async () => {
		const runtime: FakeRuntime = {
			judgeQuery: async () => ({
				verdict: "pass" as const,
				confidence: 0.9,
				reasoning: "",
				data: { evolve: true, reason: "user taught a naming convention" },
				model: "claude-haiku-4-5",
				inputTokens: 420,
				outputTokens: 48,
				costUsd: 0.0006,
				durationMs: 1200,
			}),
		};
		const decision = await decideGate(makeSession(), runtime as unknown as AgentRuntime);
		expect(decision.fire).toBe(true);
		expect(decision.source).toBe("haiku");
		expect(decision.haiku_cost_usd).toBeCloseTo(0.0006, 6);
		expect(decision.reason).toContain("naming");
	});

	test("gate forwards omitPreset=true so judgeQuery skips the claude_code preset envelope", async () => {
		// The gate is a pure pass/skip evaluation that never reads files or
		// runs tools, so it must opt out of the `claude_code` system prompt
		// preset that bundles the full Claude Code base prompt and tool
		// catalog. Live fleet data showed gate cost running 20-180x the
		// research target until this flag was wired through. Asserting the
		// flag at the call site is the durable defense against a future
		// refactor accidentally re-introducing the preset overhead.
		const captured: Array<{ omitPreset?: boolean; model?: string; maxTokens?: number }> = [];
		const runtime: FakeRuntime = {
			judgeQuery: async (options) => {
				captured.push({
					omitPreset: options.omitPreset,
					model: options.model,
					maxTokens: options.maxTokens,
				});
				return {
					verdict: "pass" as const,
					confidence: 0.9,
					reasoning: "",
					data: { evolve: false, reason: "routine" },
					model: "claude-haiku-4-5",
					inputTokens: 420,
					outputTokens: 28,
					costUsd: 0.0005,
					durationMs: 900,
				};
			},
		};
		await decideGate(makeSession(), runtime as unknown as AgentRuntime);
		expect(captured).toHaveLength(1);
		expect(captured[0].omitPreset).toBe(true);
		expect(captured[0].maxTokens).toBe(200);
	});

	test("evolve=false returns skip source=haiku", async () => {
		const runtime: FakeRuntime = {
			judgeQuery: async () => ({
				verdict: "pass" as const,
				confidence: 0.9,
				reasoning: "",
				data: { evolve: false, reason: "routine task with no new information" },
				model: "claude-haiku-4-5",
				inputTokens: 420,
				outputTokens: 28,
				costUsd: 0.0005,
				durationMs: 900,
			}),
		};
		const decision = await decideGate(makeSession(), runtime as unknown as AgentRuntime);
		expect(decision.fire).toBe(false);
		expect(decision.source).toBe("haiku");
		expect(decision.reason).toContain("routine");
	});
});

describe("decideGate failsafe path", () => {
	beforeEach(() => setupEnv());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("parse failure triggers failsafe fire", async () => {
		const runtime: FakeRuntime = {
			judgeQuery: async () => {
				throw new Error("Judge output failed schema validation");
			},
		};
		const decision = await decideGate(makeSession(), runtime as unknown as AgentRuntime);
		expect(decision.fire).toBe(true);
		expect(decision.source).toBe("failsafe");
		expect(decision.reason).toContain("gate error");
	});

	test("subprocess error (JudgeSubprocessError) triggers failsafe with partial cost", async () => {
		const runtime: FakeRuntime = {
			judgeQuery: async () => {
				throw new JudgeSubprocessError("simulated SIGKILL", {
					inputTokens: 380,
					outputTokens: 0,
					costUsd: 0.0003,
					model: "claude-haiku-4-5",
					durationMs: 800,
				});
			},
		};
		const decision = await decideGate(makeSession(), runtime as unknown as AgentRuntime);
		expect(decision.fire).toBe(true);
		expect(decision.source).toBe("failsafe");
		expect(decision.haiku_cost_usd).toBeCloseTo(0.0003, 6);
	});

	test("null runtime triggers failsafe fire with zero cost", async () => {
		const decision = await decideGate(makeSession(), null);
		expect(decision.fire).toBe(true);
		expect(decision.source).toBe("failsafe");
		expect(decision.haiku_cost_usd).toBe(0);
	});
});

describe("gate observability", () => {
	beforeEach(() => setupEnv());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("appendGateLog writes one json line per call with the full decision shape", () => {
		const config = setupEnv();
		const session = makeSession();
		const decision: GateDecision = {
			fire: true,
			source: "haiku",
			reason: "test reason",
			haiku_cost_usd: 0.0006,
		};
		appendGateLog(config, session, decision);
		appendGateLog(config, session, { ...decision, fire: false, reason: "other reason" });
		const logPath = `${TEST_DIR}/phantom-config/meta/evolution-gate-log.jsonl`;
		expect(existsSync(logPath)).toBe(true);
		const contents = readFileSync(logPath, "utf-8");
		const lines = contents.trim().split("\n");
		expect(lines.length).toBe(2);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.session_id).toBe("sess-1");
		expect(parsed.fire).toBe(true);
		expect(parsed.source).toBe("haiku");
		expect(parsed.haiku_cost_usd).toBeCloseTo(0.0006, 6);
		expect(typeof parsed.ts).toBe("string");
		// The minimal gate shape no longer carries rule_index: make sure it
		// is absent from the persisted log line so downstream consumers do
		// not accidentally key on a field that never exists in production.
		expect(parsed.rule_index).toBeUndefined();
	});

	test("recordGateDecision increments gate_stats counters correctly across mixed decisions", () => {
		const config = setupEnv();
		recordGateDecision(config, { fire: true, source: "haiku", reason: "r1", haiku_cost_usd: 0.0006 });
		recordGateDecision(config, { fire: false, source: "haiku", reason: "r2", haiku_cost_usd: 0.0005 });
		recordGateDecision(config, { fire: true, source: "failsafe", reason: "r3", haiku_cost_usd: 0 });

		const metrics = JSON.parse(readFileSync(config.paths.metrics_file, "utf-8"));
		const stats = metrics.gate_stats;
		expect(stats.total_decisions).toBe(3);
		expect(stats.fired_by_haiku).toBe(1);
		expect(stats.skipped_by_haiku).toBe(1);
		expect(stats.fired_by_failsafe).toBe(1);
		expect(stats.haiku_cost_usd_total).toBeCloseTo(0.0011, 6);
	});

	test("emptyGateStats returns all-zero counters", () => {
		const stats = emptyGateStats();
		expect(stats.total_decisions).toBe(0);
		expect(stats.fired_by_haiku).toBe(0);
		expect(stats.skipped_by_haiku).toBe(0);
		expect(stats.fired_by_failsafe).toBe(0);
		expect(stats.haiku_cost_usd_total).toBe(0);
	});
});

describe("engine.enqueueIfWorthy routing", () => {
	beforeEach(() => setupEnv());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("fire=true routes session into the queue when wired", async () => {
		const config = setupEnv();
		const configPath = `${TEST_DIR}/evolution.yaml`;
		writeFileSync(
			configPath,
			[
				"reflection:",
				'  enabled: "never"',
				"paths:",
				`  config_dir: "${config.paths.config_dir}"`,
				`  constitution: "${config.paths.constitution}"`,
				`  version_file: "${config.paths.version_file}"`,
				`  metrics_file: "${config.paths.metrics_file}"`,
				`  evolution_log: "${config.paths.evolution_log}"`,
				`  session_log: "${config.paths.session_log}"`,
			].join("\n"),
			"utf-8",
		);
		writeFileSync(`${config.paths.config_dir}/constitution.md`, "1. Honesty\n", "utf-8");
		writeFileSync(
			config.paths.version_file,
			JSON.stringify({
				version: 0,
				parent: null,
				timestamp: "2026-03-25T00:00:00Z",
				changes: [],
				metrics_at_change: { session_count: 0, success_rate_7d: 0 },
			}),
			"utf-8",
		);

		const { Database } = await import("bun:sqlite");
		const { MIGRATIONS } = await import("../../db/schema.ts");
		const { EvolutionEngine } = await import("../engine.ts");
		const { EvolutionQueue } = await import("../queue.ts");

		const db = new Database(":memory:");
		for (const stmt of MIGRATIONS) db.run(stmt);

		const runtime: FakeRuntime = {
			judgeQuery: async () => ({
				verdict: "pass" as const,
				confidence: 0.9,
				reasoning: "",
				data: { evolve: true, reason: "user taught a workflow pattern" },
				model: "claude-haiku-4-5",
				inputTokens: 420,
				outputTokens: 48,
				costUsd: 0.0006,
				durationMs: 1200,
			}),
		};

		const engine = new EvolutionEngine(configPath, runtime as unknown as AgentRuntime);
		const queue = new EvolutionQueue(db);
		engine.setQueueWiring(queue, () => undefined);

		const result = await engine.enqueueIfWorthy(makeSession());
		expect(result.enqueued).toBe(true);
		expect(result.decision.fire).toBe(true);
		expect(queue.depth()).toBe(1);
	});

	test("fire=false does not enqueue and returns enqueued=false", async () => {
		const config = setupEnv();
		const configPath = `${TEST_DIR}/evolution.yaml`;
		writeFileSync(
			configPath,
			[
				"reflection:",
				'  enabled: "never"',
				"paths:",
				`  config_dir: "${config.paths.config_dir}"`,
				`  constitution: "${config.paths.constitution}"`,
				`  version_file: "${config.paths.version_file}"`,
				`  metrics_file: "${config.paths.metrics_file}"`,
				`  evolution_log: "${config.paths.evolution_log}"`,
				`  session_log: "${config.paths.session_log}"`,
			].join("\n"),
			"utf-8",
		);
		writeFileSync(`${config.paths.config_dir}/constitution.md`, "1. Honesty\n", "utf-8");
		writeFileSync(
			config.paths.version_file,
			JSON.stringify({
				version: 0,
				parent: null,
				timestamp: "2026-03-25T00:00:00Z",
				changes: [],
				metrics_at_change: { session_count: 0, success_rate_7d: 0 },
			}),
			"utf-8",
		);

		const { Database } = await import("bun:sqlite");
		const { MIGRATIONS } = await import("../../db/schema.ts");
		const { EvolutionEngine } = await import("../engine.ts");
		const { EvolutionQueue } = await import("../queue.ts");

		const db = new Database(":memory:");
		for (const stmt of MIGRATIONS) db.run(stmt);

		const runtime: FakeRuntime = {
			judgeQuery: async () => ({
				verdict: "pass" as const,
				confidence: 0.9,
				reasoning: "",
				data: { evolve: false, reason: "routine completion" },
				model: "claude-haiku-4-5",
				inputTokens: 420,
				outputTokens: 28,
				costUsd: 0.0005,
				durationMs: 900,
			}),
		};

		const engine = new EvolutionEngine(configPath, runtime as unknown as AgentRuntime);
		const queue = new EvolutionQueue(db);
		engine.setQueueWiring(queue, () => undefined);

		const result = await engine.enqueueIfWorthy(makeSession());
		expect(result.enqueued).toBe(false);
		expect(result.decision.fire).toBe(false);
		expect(queue.depth()).toBe(0);
	});
});
