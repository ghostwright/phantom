import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { EvolutionConfig } from "../config.ts";
import {
	emptyReflectionStats,
	getMetricsSnapshot,
	readMetrics,
	recordReflectionRun,
	updateAfterEvolution,
	updateAfterSession,
	writeMetrics,
} from "../metrics.ts";
import type { EvolutionMetrics } from "../types.ts";

// Phase 3 metrics tests. Auto-rollback, daily cost cap, and the
// consolidation counter are gone; the new reflection_stats block is the
// primary observability window and must merge correctly across drains.

const TEST_DIR = "/tmp/phantom-test-metrics";

function testConfig(): EvolutionConfig {
	return {
		reflection: { enabled: "never" },
		paths: {
			config_dir: TEST_DIR,
			constitution: `${TEST_DIR}/constitution.md`,
			version_file: `${TEST_DIR}/meta/version.json`,
			metrics_file: `${TEST_DIR}/meta/metrics.json`,
			evolution_log: `${TEST_DIR}/meta/evolution-log.jsonl`,
			session_log: `${TEST_DIR}/memory/session-log.jsonl`,
		},
	};
}

function seed(): void {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(`${TEST_DIR}/meta`, { recursive: true });
	writeFileSync(`${TEST_DIR}/meta/metrics.json`, "{}", "utf-8");
}

describe("evolution metrics", () => {
	beforeEach(() => seed());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("readMetrics fills defaults on an empty file", () => {
		const metrics = readMetrics(testConfig());
		expect(metrics.session_count).toBe(0);
		expect(metrics.evolution_count).toBe(0);
		expect(metrics.success_count).toBe(0);
	});

	test("readMetrics preserves existing fields but fills unseen fields with defaults", () => {
		writeFileSync(`${TEST_DIR}/meta/metrics.json`, JSON.stringify({ session_count: 5 }), "utf-8");
		const metrics = readMetrics(testConfig());
		expect(metrics.session_count).toBe(5);
		expect(metrics.success_rate_7d).toBe(0);
	});

	test("writeMetrics round-trips a full metrics object", () => {
		const config = testConfig();
		const next: EvolutionMetrics = {
			session_count: 10,
			success_count: 8,
			failure_count: 1,
			evolution_count: 2,
			last_session_at: "2026-04-14T10:00:00Z",
			last_evolution_at: "2026-04-14T10:05:00Z",
			success_rate_7d: 0.8,
		};
		writeMetrics(config, next);
		const read = readMetrics(config);
		expect(read.session_count).toBe(10);
		expect(read.success_rate_7d).toBe(0.8);
	});

	test("updateAfterSession increments session_count and success_count", () => {
		const config = testConfig();
		updateAfterSession(config, "success");
		updateAfterSession(config, "success");
		updateAfterSession(config, "failure");
		const metrics = readMetrics(config);
		expect(metrics.session_count).toBe(3);
		expect(metrics.success_count).toBe(2);
		expect(metrics.failure_count).toBe(1);
	});

	test("updateAfterEvolution bumps evolution_count and last_evolution_at", () => {
		const config = testConfig();
		updateAfterEvolution(config);
		updateAfterEvolution(config);
		const metrics = readMetrics(config);
		expect(metrics.evolution_count).toBe(2);
		expect(metrics.last_evolution_at).not.toBeNull();
	});

	test("getMetricsSnapshot returns a flat tuple for version tagging", () => {
		const config = testConfig();
		updateAfterSession(config, "success");
		updateAfterSession(config, "success");
		const snapshot = getMetricsSnapshot(config);
		expect(snapshot.session_count).toBe(2);
		expect(snapshot.success_rate_7d).toBeCloseTo(1, 2);
	});

	describe("reflection_stats", () => {
		test("emptyReflectionStats initialises all fields to zero", () => {
			const stats = emptyReflectionStats();
			expect(stats.drains).toBe(0);
			expect(stats.stage_haiku_runs).toBe(0);
			expect(stats.total_cost_usd).toBe(0);
			expect(stats.files_touched).toEqual({});
		});

		test("recordReflectionRun merges a delta into metrics.json", () => {
			const config = testConfig();
			recordReflectionRun(config, {
				drains: 1,
				stage_haiku_runs: 1,
				status_ok: 1,
				total_cost_usd: 0.001,
				files_touched: { "user-profile.md": 1 },
			});
			const metrics = JSON.parse(readFileSync(`${TEST_DIR}/meta/metrics.json`, "utf-8"));
			expect(metrics.reflection_stats.drains).toBe(1);
			expect(metrics.reflection_stats.stage_haiku_runs).toBe(1);
			expect(metrics.reflection_stats.files_touched["user-profile.md"]).toBe(1);
		});

		test("recordReflectionRun accumulates across multiple drains", () => {
			const config = testConfig();
			recordReflectionRun(config, { drains: 1, stage_haiku_runs: 1, status_ok: 1, total_cost_usd: 0.001 });
			recordReflectionRun(config, { drains: 1, stage_sonnet_runs: 1, status_ok: 1, total_cost_usd: 0.01 });
			recordReflectionRun(config, { drains: 1, stage_haiku_runs: 1, status_skip: 1, total_cost_usd: 0.0005 });
			const metrics = JSON.parse(readFileSync(`${TEST_DIR}/meta/metrics.json`, "utf-8"));
			expect(metrics.reflection_stats.drains).toBe(3);
			expect(metrics.reflection_stats.stage_haiku_runs).toBe(2);
			expect(metrics.reflection_stats.stage_sonnet_runs).toBe(1);
			expect(metrics.reflection_stats.status_ok).toBe(2);
			expect(metrics.reflection_stats.status_skip).toBe(1);
			expect(metrics.reflection_stats.total_cost_usd).toBeCloseTo(0.0115, 5);
		});

		test("files_touched accumulates per-file counts", () => {
			const config = testConfig();
			recordReflectionRun(config, {
				drains: 1,
				files_touched: { "user-profile.md": 1, "persona.md": 1 },
			});
			recordReflectionRun(config, {
				drains: 1,
				files_touched: { "user-profile.md": 1, "domain-knowledge.md": 1 },
			});
			const metrics = JSON.parse(readFileSync(`${TEST_DIR}/meta/metrics.json`, "utf-8"));
			expect(metrics.reflection_stats.files_touched["user-profile.md"]).toBe(2);
			expect(metrics.reflection_stats.files_touched["persona.md"]).toBe(1);
			expect(metrics.reflection_stats.files_touched["domain-knowledge.md"]).toBe(1);
		});

		test("recordReflectionRun tolerates a missing metrics.json", () => {
			rmSync(`${TEST_DIR}/meta/metrics.json`);
			const config = testConfig();
			recordReflectionRun(config, { drains: 1, stage_haiku_runs: 1 });
			const metrics = JSON.parse(readFileSync(`${TEST_DIR}/meta/metrics.json`, "utf-8"));
			expect(metrics.reflection_stats.drains).toBe(1);
		});

		test("recordReflectionRun preserves existing non-reflection metrics", () => {
			writeFileSync(
				`${TEST_DIR}/meta/metrics.json`,
				JSON.stringify({ session_count: 42, gate_stats: { total_decisions: 7 } }),
				"utf-8",
			);
			const config = testConfig();
			recordReflectionRun(config, { drains: 1 });
			const metrics = JSON.parse(readFileSync(`${TEST_DIR}/meta/metrics.json`, "utf-8"));
			expect(metrics.session_count).toBe(42);
			expect(metrics.gate_stats.total_decisions).toBe(7);
			expect(metrics.reflection_stats.drains).toBe(1);
		});
	});
});
