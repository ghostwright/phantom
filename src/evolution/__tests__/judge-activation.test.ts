import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { EvolutionEngine } from "../engine.ts";

const TEST_DIR = "/tmp/phantom-test-judge-activation";
const CONFIG_PATH = `${TEST_DIR}/config/evolution.yaml`;

function setupWithJudgeMode(enabled: "auto" | "always" | "never"): void {
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
			`  enabled: "${enabled}"`,
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
}

describe("Judge Activation", () => {
	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("auto mode enables judges (Agent SDK always available)", () => {
		setupWithJudgeMode("auto");
		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.usesLLMJudges()).toBe(true);
	});

	test("never mode disables judges", () => {
		setupWithJudgeMode("never");
		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.usesLLMJudges()).toBe(false);
	});

	test("always mode enables judges", () => {
		setupWithJudgeMode("always");
		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.usesLLMJudges()).toBe(true);
	});

	test("missing judges section defaults to auto (enabled)", () => {
		mkdirSync(`${TEST_DIR}/config`, { recursive: true });
		mkdirSync(`${TEST_DIR}/phantom-config/meta`, { recursive: true });
		mkdirSync(`${TEST_DIR}/phantom-config/strategies`, { recursive: true });
		mkdirSync(`${TEST_DIR}/phantom-config/memory`, { recursive: true });

		// Config without judges section
		writeFileSync(
			CONFIG_PATH,
			[
				"cadence:",
				"  reflection_interval: 1",
				"  consolidation_interval: 10",
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

		// Auto mode + Agent SDK = always enabled
		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.usesLLMJudges()).toBe(true);
	});
});
