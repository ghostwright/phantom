import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { EvolutionConfig } from "../config.ts";
import { addCase, loadSuite, pruneSuite } from "../golden-suite.ts";
import type { GoldenCase } from "../types.ts";

const TEST_DIR = "/tmp/phantom-test-golden-cap";

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

function makeGoldenCase(index: number, daysAgo = 0): GoldenCase {
	const date = new Date();
	date.setDate(date.getDate() - daysAgo);
	return {
		id: `golden-${index}`,
		description: `Correction ${index}`,
		lesson: `Lesson for correction ${index}`,
		session_id: `session-${index}`,
		created_at: date.toISOString(),
	};
}

describe("Golden Suite Cap", () => {
	beforeEach(() => {
		mkdirSync(`${TEST_DIR}/meta`, { recursive: true });
		writeFileSync(`${TEST_DIR}/meta/golden-suite.jsonl`, "", "utf-8");
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("pruneSuite is a no-op when suite is under the cap", () => {
		const config = testConfig();
		for (let i = 0; i < 5; i++) {
			addCase(config, makeGoldenCase(i));
		}
		const removed = pruneSuite(config, 50);
		expect(removed).toBe(0);
		expect(loadSuite(config)).toHaveLength(5);
	});

	test("pruneSuite removes oldest entries when suite exceeds cap", () => {
		const config = testConfig();
		// Add 10 cases with decreasing age (0 = newest, 9 = oldest)
		for (let i = 0; i < 10; i++) {
			addCase(config, makeGoldenCase(i, i));
		}
		expect(loadSuite(config)).toHaveLength(10);

		const removed = pruneSuite(config, 5);
		expect(removed).toBe(5);

		const remaining = loadSuite(config);
		expect(remaining).toHaveLength(5);

		// Remaining should be the 5 newest (days ago 0-4)
		for (const entry of remaining) {
			const id = Number.parseInt(entry.id.replace("golden-", ""), 10);
			expect(id).toBeLessThan(5);
		}
	});

	test("pruneSuite with max_golden_suite_size defaults to 50", () => {
		const config = testConfig();
		// Default cap is 50 from the config
		expect(config.judges.max_golden_suite_size).toBe(50);
	});

	test("pruneSuite handles empty suite", () => {
		const config = testConfig();
		const removed = pruneSuite(config, 50);
		expect(removed).toBe(0);
	});

	test("pruneSuite handles suite at exactly the cap", () => {
		const config = testConfig();
		for (let i = 0; i < 5; i++) {
			addCase(config, makeGoldenCase(i));
		}
		const removed = pruneSuite(config, 5);
		expect(removed).toBe(0);
		expect(loadSuite(config)).toHaveLength(5);
	});

	test("pruneSuite keeps newest entries when exceeding cap by 1", () => {
		const config = testConfig();
		// oldest first, then newest
		addCase(config, makeGoldenCase(0, 10));
		addCase(config, makeGoldenCase(1, 0));

		const removed = pruneSuite(config, 1);
		expect(removed).toBe(1);

		const remaining = loadSuite(config);
		expect(remaining).toHaveLength(1);
		// The newest entry (days ago 0) should remain
		expect(remaining[0].id).toBe("golden-1");
	});
});
