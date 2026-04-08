import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

let savedApiKey: string | undefined;
let savedAuthToken: string | undefined;
let savedOauthToken: string | undefined;
let savedJudgeKey: string | undefined;

describe("Judge Activation", () => {
	beforeEach(() => {
		savedApiKey = process.env.ANTHROPIC_API_KEY;
		savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
		savedOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
		savedJudgeKey = process.env.JUDGE_API_KEY;
		// Clear all auth env vars so tests control them explicitly
		process.env.ANTHROPIC_AUTH_TOKEN = undefined;
		process.env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
		process.env.JUDGE_API_KEY = undefined;
	});

	afterEach(() => {
		if (savedApiKey !== undefined) {
			process.env.ANTHROPIC_API_KEY = savedApiKey;
		} else {
			process.env.ANTHROPIC_API_KEY = undefined;
		}
		if (savedAuthToken !== undefined) {
			process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
		} else {
			process.env.ANTHROPIC_AUTH_TOKEN = undefined;
		}
		if (savedOauthToken !== undefined) {
			process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
		} else {
			process.env.CLAUDE_CODE_OAUTH_TOKEN = undefined;
		}
		if (savedJudgeKey !== undefined) {
			process.env.JUDGE_API_KEY = savedJudgeKey;
		} else {
			process.env.JUDGE_API_KEY = undefined;
		}
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("auto mode enables judges when ANTHROPIC_API_KEY is set", () => {
		process.env.ANTHROPIC_API_KEY = "sk-test-key";
		setupWithJudgeMode("auto");
		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.usesLLMJudges()).toBe(true);
	});

	test("auto mode disables judges when ANTHROPIC_API_KEY is missing", () => {
		process.env.ANTHROPIC_API_KEY = undefined;
		setupWithJudgeMode("auto");
		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.usesLLMJudges()).toBe(false);
	});

	test("auto mode enables judges with ANTHROPIC_AUTH_TOKEN alone", () => {
		process.env.ANTHROPIC_API_KEY = undefined;
		process.env.ANTHROPIC_AUTH_TOKEN = "auth-token-test";
		setupWithJudgeMode("auto");
		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.usesLLMJudges()).toBe(true);
	});

	test("auto mode enables judges with CLAUDE_CODE_OAUTH_TOKEN alone", () => {
		process.env.ANTHROPIC_API_KEY = undefined;
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token-test";
		setupWithJudgeMode("auto");
		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.usesLLMJudges()).toBe(true);
	});

	test("auto mode enables judges with JUDGE_API_KEY alone", () => {
		process.env.ANTHROPIC_API_KEY = undefined;
		process.env.JUDGE_API_KEY = "sk-judge-test-key";
		setupWithJudgeMode("auto");
		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.usesLLMJudges()).toBe(true);
	});

	test("never mode disables judges even when API key is set", () => {
		process.env.ANTHROPIC_API_KEY = "sk-test-key";
		setupWithJudgeMode("never");
		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.usesLLMJudges()).toBe(false);
	});

	test("always mode enables judges regardless of API key", () => {
		process.env.ANTHROPIC_API_KEY = undefined;
		setupWithJudgeMode("always");
		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.usesLLMJudges()).toBe(true);
	});

	test("usesLLMJudges accessor matches resolved state", () => {
		process.env.ANTHROPIC_API_KEY = "sk-test-key";
		setupWithJudgeMode("auto");
		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.usesLLMJudges()).toBe(true);

		process.env.ANTHROPIC_API_KEY = undefined;
		setupWithJudgeMode("auto");
		const engine2 = new EvolutionEngine(CONFIG_PATH);
		expect(engine2.usesLLMJudges()).toBe(false);
	});

	test("missing judges section defaults to auto mode", () => {
		process.env.ANTHROPIC_API_KEY = undefined;
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

		// No API key + auto = disabled
		const engine = new EvolutionEngine(CONFIG_PATH);
		expect(engine.usesLLMJudges()).toBe(false);
	});
});
