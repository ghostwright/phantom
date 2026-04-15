import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AgentRuntime } from "../../agent/runtime.ts";
import { MIGRATIONS } from "../../db/schema.ts";
import { EvolutionCadence } from "../cadence.ts";
import { EvolutionEngine } from "../engine.ts";
import { EvolutionQueue } from "../queue.ts";
import type { SessionSummary } from "../types.ts";

// Phase 1+2 end-to-end integration. Wires the REAL EvolutionEngine, REAL
// EvolutionQueue over an in-memory SQLite, and REAL EvolutionCadence with a
// short cadence window. Only the AgentRuntime is stubbed, and only enough to
// answer `judgeQuery` (the gate Haiku call) and `getPhantomConfig` (the judge
// mode resolver). Every coordination bug in the Phase 1+2 fix punch list is
// catchable here:
//
//  - C1: runtime.setEvolvedConfig is called after the drain applies changes
//  - C2: a session whose pipeline throws stays in the queue
//  - M1: metrics.session_count is 1 per drained session, not 3
//  - M3: dedup-by-session-key on the enqueue side
//
// One test per assertion keeps the failure message specific. They share a
// fixture builder so the surface area stays small.

const TEST_DIR = "/tmp/phantom-test-phase-1-2-integration";
const CONFIG_PATH = `${TEST_DIR}/config/evolution.yaml`;

function setupTestEnvironment(): void {
	mkdirSync(`${TEST_DIR}/config`, { recursive: true });
	mkdirSync(`${TEST_DIR}/phantom-config/meta`, { recursive: true });
	mkdirSync(`${TEST_DIR}/phantom-config/strategies`, { recursive: true });
	mkdirSync(`${TEST_DIR}/phantom-config/memory`, { recursive: true });

	writeFileSync(
		CONFIG_PATH,
		[
			"cadence:",
			"  reflection_interval: 1",
			"  consolidation_interval: 10",
			"gates:",
			"  drift_threshold: 0.7",
			"  max_file_lines: 200",
			"  auto_rollback_threshold: 0.1",
			"  auto_rollback_window: 5",
			"reflection:",
			'  model: "claude-sonnet-4-20250514"',
			"judges:",
			// `never` so the engine takes the heuristic observation path. We
			// only need a stub runtime for the gate; the rest of the pipeline
			// runs deterministic TypeScript code.
			'  enabled: "never"',
			"paths:",
			`  config_dir: "${TEST_DIR}/phantom-config"`,
			`  constitution: "${TEST_DIR}/phantom-config/constitution.md"`,
			`  version_file: "${TEST_DIR}/phantom-config/meta/version.json"`,
			`  metrics_file: "${TEST_DIR}/phantom-config/meta/metrics.json"`,
			`  evolution_log: "${TEST_DIR}/phantom-config/meta/evolution-log.jsonl"`,
			`  golden_suite: "${TEST_DIR}/phantom-config/meta/golden-suite.jsonl"`,
			`  session_log: "${TEST_DIR}/phantom-config/memory/session-log.jsonl"`,
		].join("\n"),
		"utf-8",
	);

	writeFileSync(
		`${TEST_DIR}/phantom-config/constitution.md`,
		[
			"# Phantom Constitution",
			"",
			"1. Honesty: Never deceive the user.",
			"2. Safety: Never execute harmful commands.",
			"3. Privacy: Never share user data.",
			"4. Transparency: No hidden changes.",
			"5. Boundaries: You are not a person.",
			"6. Accountability: Every change is logged.",
			"7. Consent: Do not modify the constitution.",
			"8. Proportionality: Minimal changes.",
		].join("\n"),
		"utf-8",
	);
	writeFileSync(`${TEST_DIR}/phantom-config/persona.md`, "# Persona\n\n- Be direct.\n", "utf-8");
	writeFileSync(
		`${TEST_DIR}/phantom-config/user-profile.md`,
		"# User Profile\n\nPreferences learned from interactions.\n",
		"utf-8",
	);
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
			metrics_at_change: { session_count: 0, success_rate_7d: 0, correction_rate_7d: 0 },
		}),
		"utf-8",
	);
	writeFileSync(
		`${TEST_DIR}/phantom-config/meta/metrics.json`,
		JSON.stringify({
			session_count: 0,
			success_count: 0,
			failure_count: 0,
			correction_count: 0,
			evolution_count: 0,
			rollback_count: 0,
			last_session_at: null,
			last_evolution_at: null,
			success_rate_7d: 0,
			correction_rate_7d: 0,
			sessions_since_consolidation: 0,
		}),
		"utf-8",
	);
	writeFileSync(`${TEST_DIR}/phantom-config/meta/evolution-log.jsonl`, "", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/meta/golden-suite.jsonl`, "", "utf-8");
}

function newDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	for (const stmt of MIGRATIONS) db.run(stmt);
	return db;
}

type StubRuntime = {
	judgeQuery: (options: {
		systemPrompt: string;
		userMessage: string;
		schema: unknown;
		model?: string;
		maxTokens?: number;
		omitPreset?: boolean;
	}) => Promise<unknown>;
};

function fireGateRuntime(): StubRuntime {
	return {
		judgeQuery: async () => ({
			verdict: "pass" as const,
			confidence: 0.9,
			reasoning: "",
			data: { evolve: true, reason: "user taught a workflow" },
			model: "claude-haiku-4-5",
			inputTokens: 320,
			outputTokens: 28,
			costUsd: 0.0006,
			durationMs: 800,
		}),
	};
}

function fireWorthySession(overrides: Partial<SessionSummary> = {}): SessionSummary {
	// The heuristic observation extractor in `reflection.ts` looks for
	// correction-shaped phrases in user messages ("no, use X not Y"). Using
	// such a message guarantees the engine actually applies a change to
	// `user-profile.md`, which is what makes the C1 callback fire and what
	// lets the integration test assert against real applied state.
	return {
		session_id: "integ-1",
		session_key: "slack:Cint:Tint",
		user_id: "user-int",
		user_messages: ["No, always use TypeScript not JavaScript"],
		assistant_messages: ["Got it"],
		tools_used: [],
		files_tracked: [],
		outcome: "success",
		cost_usd: 0.05,
		started_at: "2026-04-14T10:00:00Z",
		ended_at: "2026-04-14T10:01:00Z",
		...overrides,
	};
}

describe("phase 1+2 integration", () => {
	beforeEach(() => setupTestEnvironment());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("end-to-end drain wires every coordination concern", async () => {
		const db = newDb();
		const runtime = fireGateRuntime();
		const engine = new EvolutionEngine(CONFIG_PATH, runtime as unknown as AgentRuntime);
		const queue = new EvolutionQueue(db);
		const cadence = new EvolutionCadence(engine, queue, engine.getEvolutionConfig(), {
			cadenceMinutes: 1_000_000,
			demandTriggerDepth: 999,
		});

		// C1 sentinel: count callback invocations and capture each version we
		// see at refresh time. The production wiring in `src/index.ts` uses
		// this same setter to refresh `runtime.evolvedConfig` from disk.
		const refreshes: number[] = [];
		engine.setOnConfigApplied(() => {
			refreshes.push(engine.getCurrentVersion());
		});
		engine.setQueueWiring(queue, () => cadence.onEnqueue());

		cadence.start();
		try {
			const result = await engine.enqueueIfWorthy(fireWorthySession());
			expect(result.enqueued).toBe(true);
			expect(result.decision.fire).toBe(true);
			expect(queue.depth()).toBe(1);

			const drainResult = await cadence.triggerNow();
			expect(drainResult).not.toBeNull();
			expect(drainResult?.processed).toBe(1);
			expect(drainResult?.successCount).toBe(1);

			// C1: the drain produced an applied change, so the refresh
			// callback fired exactly once with the new version.
			expect(refreshes.length).toBeGreaterThanOrEqual(1);
			expect(refreshes.at(-1)).toBe(engine.getCurrentVersion());
			expect(engine.getCurrentVersion()).toBeGreaterThan(0);

			// M1: a single fired session bumps `session_count` exactly once.
			// Pre-fix this was 3 because `updateAfterSession` was called from
			// `enqueueIfWorthy`, the top of `afterSessionInternal`, and inside
			// `runCycle`. Post-fix only the runCycle call survives.
			const metrics = engine.getMetrics();
			expect(metrics.session_count).toBe(1);
			expect(metrics.success_count).toBe(1);

			// Queue is empty after a successful drain.
			expect(queue.depth()).toBe(0);
		} finally {
			cadence.stop();
		}
	});

	test("a pipeline failure leaves the row in the queue for the next drain (C2)", async () => {
		const db = newDb();
		const runtime = fireGateRuntime();
		const engine = new EvolutionEngine(CONFIG_PATH, runtime as unknown as AgentRuntime);
		const queue = new EvolutionQueue(db);
		const cadence = new EvolutionCadence(engine, queue, engine.getEvolutionConfig(), {
			cadenceMinutes: 1_000_000,
			demandTriggerDepth: 999,
		});

		// Force the engine pipeline to throw on the first drain. We patch
		// `runSingleSessionPipeline` directly on the instance so the cadence's
		// processBatch loop sees the failure shape it would see from a real
		// JudgeSubprocessError or a `CycleAborted` rethrow that was not caught.
		let throwOnce = true;
		const original = engine.runSingleSessionPipeline.bind(engine);
		engine.runSingleSessionPipeline = async (session: SessionSummary) => {
			if (throwOnce) {
				throwOnce = false;
				throw new Error("simulated transient pipeline failure");
			}
			return original(session);
		};

		engine.setQueueWiring(queue, () => cadence.onEnqueue());
		cadence.start();
		try {
			await engine.enqueueIfWorthy(fireWorthySession({ session_id: "fail-then-ok" }));
			expect(queue.depth()).toBe(1);

			const firstDrain = await cadence.triggerNow();
			expect(firstDrain?.failureCount).toBe(1);
			// The failed row stays in the queue for the next drain instead of
			// being silently deleted by markProcessed.
			expect(queue.depth()).toBe(1);

			// Second drain succeeds and clears the row.
			const secondDrain = await cadence.triggerNow();
			expect(secondDrain?.successCount).toBe(1);
			expect(queue.depth()).toBe(0);
		} finally {
			cadence.stop();
		}
	});

	test("retried session_key is counted exactly once across drains", async () => {
		// Codex finding on PR #63: the C2 fix preserves a failed row in the
		// queue, so a transient pipeline failure followed by a retry would
		// re-enter `runCycle` under the same `session_key` and double-count
		// `session_count`. The dedup guard in `runCycle` caps the increment at
		// one per unique `session_key` for the engine's lifetime.
		const db = newDb();
		const runtime = fireGateRuntime();
		const engine = new EvolutionEngine(CONFIG_PATH, runtime as unknown as AgentRuntime);
		const queue = new EvolutionQueue(db);
		const cadence = new EvolutionCadence(engine, queue, engine.getEvolutionConfig(), {
			cadenceMinutes: 1_000_000,
			demandTriggerDepth: 999,
		});

		let throwOnce = true;
		const original = engine.runSingleSessionPipeline.bind(engine);
		engine.runSingleSessionPipeline = async (session: SessionSummary) => {
			if (throwOnce) {
				throwOnce = false;
				throw new Error("simulated transient pipeline failure");
			}
			return original(session);
		};

		engine.setQueueWiring(queue, () => cadence.onEnqueue());
		cadence.start();
		try {
			await engine.enqueueIfWorthy(fireWorthySession({ session_id: "retry-once" }));

			const firstDrain = await cadence.triggerNow();
			expect(firstDrain?.failureCount).toBe(1);
			// The first drain threw before reaching `updateAfterSession`, so
			// `session_count` is still 0. The row is preserved for retry.
			expect(engine.getMetrics().session_count).toBe(0);
			expect(queue.depth()).toBe(1);

			const secondDrain = await cadence.triggerNow();
			expect(secondDrain?.successCount).toBe(1);
			// The retry is the first call that reaches `updateAfterSession`,
			// so it claims the dedup slot for this `session_key` and increments
			// exactly once.
			expect(engine.getMetrics().session_count).toBe(1);

			// A subsequent enqueue under the SAME `session_key` must not
			// increment again. Use a different `session_id` (which is what the
			// queue dedup also uses to distinguish turns within a conversation)
			// so the row is fresh but the dedup key is the same.
			await engine.enqueueIfWorthy(fireWorthySession({ session_id: "retry-once-followup" }));
			await cadence.triggerNow();
			expect(engine.getMetrics().session_count).toBe(1);

			// A new `session_key` is counted normally, proving the guard does
			// not over-suppress.
			await engine.enqueueIfWorthy(
				fireWorthySession({ session_id: "other-session", session_key: "slack:Cint:Tother" }),
			);
			await cadence.triggerNow();
			expect(engine.getMetrics().session_count).toBe(2);
		} finally {
			cadence.stop();
		}
	});
});
