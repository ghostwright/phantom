import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { EvolutionConfig } from "../config.ts";
import type { VersionChange } from "../types.ts";
import { createNextVersion, readVersion, rollback, writeVersion } from "../versioning.ts";

const TEST_DIR = "/tmp/phantom-test-versioning";

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

describe("Versioning", () => {
	beforeEach(() => {
		mkdirSync(`${TEST_DIR}/meta`, { recursive: true });
		writeFileSync(
			`${TEST_DIR}/meta/version.json`,
			JSON.stringify({
				version: 0,
				parent: null,
				timestamp: "2026-03-25T00:00:00Z",
				changes: [],
				metrics_at_change: { session_count: 0, success_rate_7d: 0, correction_rate_7d: 0 },
			}),
			"utf-8",
		);
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("readVersion returns initial version", () => {
		const version = readVersion(testConfig());
		expect(version.version).toBe(0);
		expect(version.parent).toBeNull();
		expect(version.changes).toHaveLength(0);
	});

	test("readVersion returns default when file missing", () => {
		rmSync(`${TEST_DIR}/meta/version.json`);
		const version = readVersion(testConfig());
		expect(version.version).toBe(0);
	});

	test("writeVersion persists to disk", () => {
		const config = testConfig();
		const version = {
			version: 1,
			parent: 0,
			timestamp: "2026-03-25T10:00:00Z",
			changes: [] as VersionChange[],
			metrics_at_change: { session_count: 5, success_rate_7d: 0.8, correction_rate_7d: 0.2 },
		};
		writeVersion(config, version);

		const read = readVersion(config);
		expect(read.version).toBe(1);
		expect(read.parent).toBe(0);
		expect(read.metrics_at_change.session_count).toBe(5);
	});

	test("createNextVersion increments version and sets parent", () => {
		const current = readVersion(testConfig());
		const changes: VersionChange[] = [
			{
				file: "user-profile.md",
				type: "append",
				content: "Prefers TypeScript",
				rationale: "User correction",
				session_ids: ["s1"],
			},
		];
		const next = createNextVersion(current, changes, { session_count: 1, success_rate_7d: 1, correction_rate_7d: 0 });

		expect(next.version).toBe(1);
		expect(next.parent).toBe(0);
		expect(next.changes).toHaveLength(1);
		expect(next.changes[0].content).toBe("Prefers TypeScript");
	});

	test("rollback reverts to previous version", () => {
		const config = testConfig();

		// Create a file to track changes
		writeFileSync(`${TEST_DIR}/user-profile.md`, "# User Profile\n", "utf-8");

		// Write version 1 with a change
		const v1 = {
			version: 1,
			parent: 0,
			timestamp: "2026-03-25T10:00:00Z",
			changes: [
				{
					file: "user-profile.md",
					type: "append" as const,
					content: "- Prefers TypeScript",
					rationale: "test",
					session_ids: ["s1"],
				},
			],
			metrics_at_change: { session_count: 1, success_rate_7d: 1, correction_rate_7d: 0 },
		};
		writeVersion(config, v1);

		// Simulate the applied change
		writeFileSync(`${TEST_DIR}/user-profile.md`, "# User Profile\n\n- Prefers TypeScript", "utf-8");

		// Write evolution log
		const logEntry = JSON.stringify({ version: 1, session_id: "s1", details: v1.changes });
		writeFileSync(config.paths.evolution_log, `${logEntry}\n`, "utf-8");

		// Rollback to version 0
		const rolledBack = rollback(config, 0);
		expect(rolledBack.version).toBe(0);

		// Version file should show version 0
		const current = readVersion(config);
		expect(current.version).toBe(0);
	});

	test("rollback throws for invalid version numbers", () => {
		const config = testConfig();
		expect(() => rollback(config, 5)).toThrow("Cannot rollback to version 5");
		expect(() => rollback(config, -1)).toThrow("version must be non-negative");
	});
});
