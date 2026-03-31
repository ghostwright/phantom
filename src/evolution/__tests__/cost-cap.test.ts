import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EvolutionEngine } from "../engine.ts";
import type { SessionSummary } from "../types.ts";

const TEST_DIR = "/tmp/phantom-test-cost-cap";
const CONFIG_PATH = `${TEST_DIR}/config/evolution.yaml`;

let savedApiKey: string | undefined;

function setupTestEnv(costCap: number): void {
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
			"judges:",
			'  enabled: "never"',
			`  cost_cap_usd_per_day: ${costCap}`,
			"  max_golden_suite_size: 50",
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

	writeFileSync(`${TEST_DIR}/phantom-config/constitution.md`, "# Constitution\n1. Be honest.\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/persona.md`, "", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/user-profile.md`, "# User Profile\n", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/domain-knowledge.md`, "", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/strategies/task-patterns.md`, "", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/strategies/tool-preferences.md`, "", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/strategies/error-recovery.md`, "", "utf-8");
	writeFileSync(`${TEST_DIR}/phantom-config/memory/session-log.jsonl`, "", "utf-8");
	writeFileSync(
		`${TEST_DIR}/phantom-config/meta/version.json`,
		JSON.stringify({
			version: 0,
			parent: null,
			timestamp: new Date().toISOString(),
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

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		session_id: `session-${Date.now()}`,
		session_key: "cli:main",
		user_id: "user-1",
		user_messages: ["No, use TypeScript not JavaScript"],
		assistant_messages: ["Got it."],
		tools_used: [],
		files_tracked: [],
		outcome: "success",
		cost_usd: 0.05,
		started_at: "2026-03-25T10:00:00Z",
		ended_at: "2026-03-25T10:05:00Z",
		...overrides,
	};
}

describe("Cost Cap", () => {
	beforeEach(() => {
		savedApiKey = process.env.ANTHROPIC_API_KEY;
	});

	afterEach(() => {
		if (savedApiKey !== undefined) {
			process.env.ANTHROPIC_API_KEY = savedApiKey;
		} else {
			process.env.ANTHROPIC_API_KEY = undefined;
		}
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("cost cap config is parsed from YAML", () => {
		setupTestEnv(10.0);
		const engine = new EvolutionEngine(CONFIG_PATH);
		const config = engine.getEvolutionConfig();
		expect(config.judges.cost_cap_usd_per_day).toBe(10.0);
	});

	test("cost cap defaults to 50 when not configured", () => {
		mkdirSync(`${TEST_DIR}/config`, { recursive: true });
		mkdirSync(`${TEST_DIR}/phantom-config/meta`, { recursive: true });
		mkdirSync(`${TEST_DIR}/phantom-config/strategies`, { recursive: true });
		mkdirSync(`${TEST_DIR}/phantom-config/memory`, { recursive: true });

		writeFileSync(
			CONFIG_PATH,
			[
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
		writeFileSync(`${TEST_DIR}/phantom-config/constitution.md`, "# Constitution\n", "utf-8");
		writeFileSync(`${TEST_DIR}/phantom-config/persona.md`, "", "utf-8");
		writeFileSync(`${TEST_DIR}/phantom-config/user-profile.md`, "", "utf-8");
		writeFileSync(`${TEST_DIR}/phantom-config/domain-knowledge.md`, "", "utf-8");
		writeFileSync(`${TEST_DIR}/phantom-config/strategies/task-patterns.md`, "", "utf-8");
		writeFileSync(`${TEST_DIR}/phantom-config/strategies/tool-preferences.md`, "", "utf-8");
		writeFileSync(`${TEST_DIR}/phantom-config/strategies/error-recovery.md`, "", "utf-8");
		writeFileSync(`${TEST_DIR}/phantom-config/memory/session-log.jsonl`, "", "utf-8");
		writeFileSync(
			`${TEST_DIR}/phantom-config/meta/version.json`,
			JSON.stringify({
				version: 0,
				parent: null,
				timestamp: new Date().toISOString(),
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

		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.getEvolutionConfig().judges.cost_cap_usd_per_day).toBe(50.0);
	});

	test("engine uses heuristic path when judges are disabled", async () => {
		setupTestEnv(50.0);
		const engine = new EvolutionEngine(CONFIG_PATH);

		// judges.enabled: "never" means heuristics
		expect(engine.usesLLMJudges()).toBe(false);

		const result = await engine.afterSession(makeSession());
		// Should still work with heuristics
		expect(result.changes_applied.length).toBeGreaterThan(0);

		const userProfile = readFileSync(`${TEST_DIR}/phantom-config/user-profile.md`, "utf-8");
		expect(userProfile).toContain("TypeScript");
	});
});
