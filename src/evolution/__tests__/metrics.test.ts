import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { EvolutionConfig } from "../config.ts";
import {
	checkForAutoRollback,
	getMetricsSnapshot,
	readMetrics,
	resetConsolidationCounter,
	updateAfterEvolution,
	updateAfterRollback,
	updateAfterSession,
} from "../metrics.ts";

const TEST_DIR = "/tmp/phantom-test-metrics";

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

describe("Metrics", () => {
	beforeEach(() => {
		mkdirSync(`${TEST_DIR}/meta`, { recursive: true });
		writeFileSync(
			`${TEST_DIR}/meta/metrics.json`,
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
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("readMetrics returns initial metrics", () => {
		const metrics = readMetrics(testConfig());
		expect(metrics.session_count).toBe(0);
		expect(metrics.success_count).toBe(0);
	});

	test("readMetrics returns defaults when file missing", () => {
		rmSync(`${TEST_DIR}/meta/metrics.json`);
		const metrics = readMetrics(testConfig());
		expect(metrics.session_count).toBe(0);
	});

	test("updateAfterSession increments session count", () => {
		const config = testConfig();
		const metrics = updateAfterSession(config, "success", false);
		expect(metrics.session_count).toBe(1);
		expect(metrics.success_count).toBe(1);
		expect(metrics.failure_count).toBe(0);
		expect(metrics.last_session_at).not.toBeNull();
	});

	test("updateAfterSession tracks failures", () => {
		const config = testConfig();
		const metrics = updateAfterSession(config, "failure", false);
		expect(metrics.failure_count).toBe(1);
		expect(metrics.success_count).toBe(0);
	});

	test("updateAfterSession tracks corrections", () => {
		const config = testConfig();
		const metrics = updateAfterSession(config, "success", true);
		expect(metrics.correction_count).toBe(1);
	});

	test("updateAfterSession calculates rolling rates", () => {
		const config = testConfig();
		updateAfterSession(config, "success", false);
		updateAfterSession(config, "success", false);
		updateAfterSession(config, "failure", true);
		const metrics = readMetrics(config);
		expect(metrics.success_rate_7d).toBeCloseTo(0.67, 1);
		expect(metrics.correction_rate_7d).toBeCloseTo(0.33, 1);
	});

	test("updateAfterEvolution increments evolution count", () => {
		const config = testConfig();
		const metrics = updateAfterEvolution(config);
		expect(metrics.evolution_count).toBe(1);
		expect(metrics.last_evolution_at).not.toBeNull();
	});

	test("updateAfterRollback increments rollback count", () => {
		const config = testConfig();
		const metrics = updateAfterRollback(config);
		expect(metrics.rollback_count).toBe(1);
	});

	test("resetConsolidationCounter resets to 0", () => {
		const config = testConfig();
		updateAfterSession(config, "success", false);
		updateAfterSession(config, "success", false);
		let metrics = readMetrics(config);
		expect(metrics.sessions_since_consolidation).toBe(2);

		resetConsolidationCounter(config);
		metrics = readMetrics(config);
		expect(metrics.sessions_since_consolidation).toBe(0);
	});

	test("getMetricsSnapshot returns current snapshot", () => {
		const config = testConfig();
		updateAfterSession(config, "success", false);
		const snapshot = getMetricsSnapshot(config);
		expect(snapshot.session_count).toBe(1);
		expect(snapshot.success_rate_7d).toBe(1);
	});

	test("checkForAutoRollback says no when not enough sessions", () => {
		const config = testConfig();
		updateAfterSession(config, "success", false);
		const result = checkForAutoRollback(config);
		expect(result.shouldRollback).toBe(false);
	});

	test("checkForAutoRollback does not trigger when metrics are stable", () => {
		const config = testConfig();
		for (let i = 0; i < 6; i++) {
			updateAfterSession(config, "success", false);
		}
		const result = checkForAutoRollback(config);
		expect(result.shouldRollback).toBe(false);
	});
});
