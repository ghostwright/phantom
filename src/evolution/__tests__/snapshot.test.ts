import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvolutionConfig } from "../config.ts";
import { buildVersionChanges, restoreSnapshot, snapshotDirectory } from "../versioning.ts";

// Dedicated Phase 3 snapshot/restore tests. Versioning.test.ts covers the
// happy path; this file focuses on edge cases: nested directories under
// writeable roots, large files, new-directory creation, and the buildDiff
// classification rules.

const TEST_DIR = "/tmp/phantom-test-snapshot";

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
	mkdirSync(`${TEST_DIR}/strategies`, { recursive: true });
	mkdirSync(`${TEST_DIR}/memory`, { recursive: true });
	writeFileSync(`${TEST_DIR}/constitution.md`, "1. Honesty\n", "utf-8");
	writeFileSync(`${TEST_DIR}/persona.md`, "# Persona\n", "utf-8");
	writeFileSync(`${TEST_DIR}/user-profile.md`, "# User Profile\n- one\n- two\n", "utf-8");
	writeFileSync(`${TEST_DIR}/strategies/task-patterns.md`, "# Tasks\n", "utf-8");
	writeFileSync(`${TEST_DIR}/memory/corrections.md`, "# Corrections\n", "utf-8");
	writeFileSync(
		`${TEST_DIR}/meta/version.json`,
		JSON.stringify({
			version: 0,
			parent: null,
			timestamp: "x",
			changes: [],
			metrics_at_change: { session_count: 0, success_rate_7d: 0 },
		}),
		"utf-8",
	);
	writeFileSync(`${TEST_DIR}/meta/metrics.json`, "{}", "utf-8");
	// Telemetry files that must NOT land in the snapshot.
	writeFileSync(`${TEST_DIR}/meta/evolution-log.jsonl`, "", "utf-8");
}

describe("snapshotDirectory edge cases", () => {
	beforeEach(() => seed());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("captures files in nested strategies/ subdirectories", () => {
		mkdirSync(`${TEST_DIR}/strategies/deploy`, { recursive: true });
		writeFileSync(`${TEST_DIR}/strategies/deploy/rollout.md`, "# Rollout\n", "utf-8");
		const snap = snapshotDirectory(testConfig());
		expect(snap.files.has("strategies/deploy/rollout.md")).toBe(true);
	});

	test("captures empty files as empty strings", () => {
		writeFileSync(`${TEST_DIR}/persona.md`, "", "utf-8");
		const snap = snapshotDirectory(testConfig());
		expect(snap.files.get("persona.md")).toBe("");
	});

	test("excludes .staging/ subtree", () => {
		mkdirSync(`${TEST_DIR}/.staging`, { recursive: true });
		writeFileSync(`${TEST_DIR}/.staging/batch-1.jsonl`, "{}\n", "utf-8");
		const snap = snapshotDirectory(testConfig());
		for (const key of snap.files.keys()) {
			expect(key.startsWith(".staging/")).toBe(false);
		}
	});

	test("excludes meta/ even when it contains many files", () => {
		writeFileSync(`${TEST_DIR}/meta/queue-stats.json`, "{}", "utf-8");
		writeFileSync(`${TEST_DIR}/meta/evolution-gate-log.jsonl`, "", "utf-8");
		const snap = snapshotDirectory(testConfig());
		for (const key of snap.files.keys()) {
			expect(key.startsWith("meta/")).toBe(false);
		}
	});

	test("large files round-trip byte-identical", () => {
		const lines = Array.from({ length: 500 }, (_, i) => `- bullet ${i}`);
		const content = `# User Profile\n${lines.join("\n")}\n`;
		writeFileSync(`${TEST_DIR}/user-profile.md`, content, "utf-8");
		const snap = snapshotDirectory(testConfig());
		expect(snap.files.get("user-profile.md")).toBe(content);
	});
});

describe("restoreSnapshot edge cases", () => {
	beforeEach(() => seed());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("removes files that did not exist at snapshot time", () => {
		const snap = snapshotDirectory(testConfig());
		writeFileSync(`${TEST_DIR}/strategies/brand-new.md`, "# New\n", "utf-8");
		restoreSnapshot(testConfig(), snap);
		expect(existsSync(`${TEST_DIR}/strategies/brand-new.md`)).toBe(false);
	});

	test("recreates files that were deleted by the subprocess", () => {
		const snap = snapshotDirectory(testConfig());
		rmSync(`${TEST_DIR}/user-profile.md`);
		restoreSnapshot(testConfig(), snap);
		expect(existsSync(`${TEST_DIR}/user-profile.md`)).toBe(true);
		expect(readFileSync(`${TEST_DIR}/user-profile.md`, "utf-8")).toBe("# User Profile\n- one\n- two\n");
	});

	test("no-op when current state already matches the snapshot", () => {
		const snap = snapshotDirectory(testConfig());
		restoreSnapshot(testConfig(), snap);
		const after = snapshotDirectory(testConfig());
		expect(after.files.size).toBe(snap.files.size);
	});

	test("leaves meta/ alone when restoring", () => {
		const snap = snapshotDirectory(testConfig());
		writeFileSync(`${TEST_DIR}/meta/some-telemetry.json`, '{"x":1}\n', "utf-8");
		restoreSnapshot(testConfig(), snap);
		expect(existsSync(`${TEST_DIR}/meta/some-telemetry.json`)).toBe(true);
	});

	test("staging directory cleanup is the caller's responsibility, not restore", () => {
		mkdirSync(`${TEST_DIR}/.staging`, { recursive: true });
		writeFileSync(`${TEST_DIR}/.staging/batch-x.jsonl`, "{}\n", "utf-8");
		const snap = snapshotDirectory(testConfig());
		restoreSnapshot(testConfig(), snap);
		// Restore does not touch .staging/ because snapshot excluded it.
		expect(existsSync(`${TEST_DIR}/.staging/batch-x.jsonl`)).toBe(true);
	});
});

describe("buildVersionChanges classification", () => {
	beforeEach(() => seed());
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	test("no changes returns an empty array", () => {
		const pre = snapshotDirectory(testConfig());
		const post = snapshotDirectory(testConfig());
		const changes = buildVersionChanges(pre, post, null, ["s1"], "r");
		expect(changes).toHaveLength(0);
	});

	test("single edit with no sentinel defaults to type=edit", () => {
		const pre = snapshotDirectory(testConfig());
		writeFileSync(`${TEST_DIR}/persona.md`, "# Persona\n\n- new line\n", "utf-8");
		const post = snapshotDirectory(testConfig());
		const changes = buildVersionChanges(pre, post, null, ["s1"], "r");
		expect(changes).toHaveLength(1);
		expect(changes[0].type).toBe("edit");
		expect(changes[0].file).toBe("persona.md");
	});

	test("large shrinkage without sentinel annotation still classifies as compact by ratio", () => {
		writeFileSync(
			`${TEST_DIR}/user-profile.md`,
			["# User Profile", ...Array.from({ length: 30 }, (_, i) => `- bullet ${i}`)].join("\n"),
			"utf-8",
		);
		const pre = snapshotDirectory(testConfig());
		writeFileSync(`${TEST_DIR}/user-profile.md`, "# User Profile\n- one summary\n", "utf-8");
		const post = snapshotDirectory(testConfig());
		const changes = buildVersionChanges(pre, post, null, ["s1"], "r");
		expect(changes[0].type).toBe("compact");
	});

	test("new file is classified as new", () => {
		const pre = snapshotDirectory(testConfig());
		writeFileSync(`${TEST_DIR}/strategies/newfile.md`, "# New\n", "utf-8");
		const post = snapshotDirectory(testConfig());
		const changes = buildVersionChanges(pre, post, null, ["s1"], "r");
		const newFile = changes.find((c) => c.file === "strategies/newfile.md");
		expect(newFile?.type).toBe("new");
	});

	test("sentinel annotation wins over diff heuristic", () => {
		const pre = snapshotDirectory(testConfig());
		writeFileSync(`${TEST_DIR}/persona.md`, "# Persona\n\n- edited line\n", "utf-8");
		const post = snapshotDirectory(testConfig());
		const changes = buildVersionChanges(
			pre,
			post,
			{
				status: "ok",
				changes: [{ file: "persona.md", action: "compact", summary: "curated" }],
			},
			["s1"],
			"r",
		);
		expect(changes[0].type).toBe("compact");
		expect(changes[0].summary).toBe("curated");
	});
});

// Silence the unused import; join is kept for future test helpers.
void join;
void readdirSync;
