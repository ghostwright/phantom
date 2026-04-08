import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { EvolutionConfig } from "../config.ts";
import { compressUserProfile } from "../consolidation.ts";

const TEST_DIR = "/tmp/phantom-test-consolidation";

function testConfig(): EvolutionConfig {
	return {
		cadence: { reflection_interval: 1, consolidation_interval: 10, full_review_interval: 50, drift_check_interval: 20 },
		gates: { drift_threshold: 0.7, max_file_lines: 200, auto_rollback_threshold: 0.1, auto_rollback_window: 5 },
		reflection: { model: "claude-sonnet-4-20250514", effort: "high", max_budget_usd: 0.5 },
		judges: { enabled: "auto", cost_cap_usd_per_day: 50.0, max_golden_suite_size: 50 },
		paths: {
			config_dir: TEST_DIR,
			constitution: `${TEST_DIR}/constitution.md`,
			version_file: `${TEST_DIR}/meta/version.json`,
			metrics_file: `${TEST_DIR}/meta/metrics.json`,
			evolution_log: `${TEST_DIR}/meta/evolution-log.jsonl`,
			golden_suite: `${TEST_DIR}/meta/golden-suite.jsonl`,
			session_log: `${TEST_DIR}/memory/session-log.jsonl`,
		},
	};
}

describe("compressUserProfile", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("deduplicates repeated lines when over size limit", () => {
		// Generate content that exceeds max_file_lines (200)
		const lines = ["# User Profile", ""];
		for (let i = 0; i < 150; i++) {
			lines.push(`- Preference ${i}`);
		}
		// Add duplicates to push over 200
		for (let i = 0; i < 60; i++) {
			lines.push(`- Preference ${i}`);
		}
		writeFileSync(`${TEST_DIR}/user-profile.md`, lines.join("\n"), "utf-8");

		const result = compressUserProfile(testConfig());
		expect(result).toBe(true);

		const compressed = readFileSync(`${TEST_DIR}/user-profile.md`, "utf-8");
		const prefMatches = compressed.match(/- Preference 0$/gm);
		expect(prefMatches).toHaveLength(1);
	});

	test("returns false when under size limit even with duplicates", () => {
		const content = ["# User Profile", "", "- Prefers TypeScript", "- Prefers TypeScript"].join("\n");
		writeFileSync(`${TEST_DIR}/user-profile.md`, content, "utf-8");

		const result = compressUserProfile(testConfig());
		expect(result).toBe(false);
	});

	test("returns false when no duplicates exist", () => {
		const content = "# User Profile\n\n- Prefers TypeScript\n- Uses Bun runtime\n";
		writeFileSync(`${TEST_DIR}/user-profile.md`, content, "utf-8");

		const result = compressUserProfile(testConfig());
		expect(result).toBe(false);
	});

	test("returns false when file does not exist", () => {
		const result = compressUserProfile(testConfig());
		expect(result).toBe(false);
	});
});
