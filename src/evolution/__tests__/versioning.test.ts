import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvolutionConfig } from "../config.ts";
import type { EvolutionVersion, SubprocessSentinel, VersionChange } from "../types.ts";
import {
	buildVersionChanges,
	createNextVersion,
	getEvolutionLog,
	migrateOldLogEntry,
	readVersion,
	restoreSnapshot,
	snapshotDirectory,
	writeVersion,
} from "../versioning.ts";

const TEST_DIR = "/tmp/phantom-test-versioning";

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

function seedConfigTree(): void {
	mkdirSync(`${TEST_DIR}/meta`, { recursive: true });
	mkdirSync(`${TEST_DIR}/strategies`, { recursive: true });
	mkdirSync(`${TEST_DIR}/memory`, { recursive: true });
	writeFileSync(`${TEST_DIR}/constitution.md`, "# Constitution\n\n1. Honesty.\n", "utf-8");
	writeFileSync(`${TEST_DIR}/persona.md`, "# Persona\n\n- Be direct.\n", "utf-8");
	writeFileSync(`${TEST_DIR}/user-profile.md`, "# User Profile\n\n- Existing bullet.\n", "utf-8");
	writeFileSync(`${TEST_DIR}/domain-knowledge.md`, "# Domain\n", "utf-8");
	writeFileSync(`${TEST_DIR}/strategies/task-patterns.md`, "# Tasks\n", "utf-8");
	writeFileSync(`${TEST_DIR}/strategies/tool-preferences.md`, "# Tools\n", "utf-8");
	writeFileSync(`${TEST_DIR}/strategies/error-recovery.md`, "# Errors\n", "utf-8");
	writeFileSync(`${TEST_DIR}/memory/corrections.md`, "# Corrections\n", "utf-8");
	writeFileSync(`${TEST_DIR}/memory/principles.md`, "# Principles\n", "utf-8");
	writeFileSync(`${TEST_DIR}/memory/session-log.jsonl`, "", "utf-8");
	writeFileSync(
		`${TEST_DIR}/meta/version.json`,
		JSON.stringify({
			version: 0,
			parent: null,
			timestamp: "2026-03-25T00:00:00Z",
			changes: [],
			metrics_at_change: { session_count: 0, success_rate_7d: 0 },
		}),
		"utf-8",
	);
	// Infrastructure telemetry that must NOT appear in a snapshot.
	writeFileSync(`${TEST_DIR}/meta/metrics.json`, '{"evolution_count":0}\n', "utf-8");
	writeFileSync(`${TEST_DIR}/meta/evolution-log.jsonl`, "", "utf-8");
}

describe("Versioning", () => {
	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		seedConfigTree();
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("readVersion returns initial version", () => {
		const version = readVersion(testConfig());
		expect(version.version).toBe(0);
		expect(version.parent).toBeNull();
	});

	test("readVersion returns default when file missing", () => {
		rmSync(`${TEST_DIR}/meta/version.json`);
		const version = readVersion(testConfig());
		expect(version.version).toBe(0);
	});

	test("writeVersion persists to disk", () => {
		const config = testConfig();
		const next: EvolutionVersion = {
			version: 1,
			parent: 0,
			timestamp: "2026-04-14T10:00:00Z",
			changes: [
				{
					file: "user-profile.md",
					type: "edit",
					summary: "added bullet",
					rationale: "drain=test",
					session_ids: ["s1"],
				},
			],
			metrics_at_change: { session_count: 1, success_rate_7d: 1 },
		};
		writeVersion(config, next);
		const persisted = JSON.parse(readFileSync(`${TEST_DIR}/meta/version.json`, "utf-8"));
		expect(persisted.version).toBe(1);
		expect(persisted.changes[0].summary).toBe("added bullet");
	});

	test("createNextVersion increments and links parent", () => {
		const current: EvolutionVersion = {
			version: 3,
			parent: 2,
			timestamp: "x",
			changes: [],
			metrics_at_change: { session_count: 0, success_rate_7d: 0 },
		};
		const changes: VersionChange[] = [
			{ file: "persona.md", type: "edit", summary: "tone", rationale: "r", session_ids: ["s"] },
		];
		const next = createNextVersion(current, changes, { session_count: 0, success_rate_7d: 0 });
		expect(next.version).toBe(4);
		expect(next.parent).toBe(3);
		expect(next.changes).toEqual(changes);
	});

	describe("snapshotDirectory / restoreSnapshot", () => {
		test("snapshot captures every non-meta file", () => {
			const snap = snapshotDirectory(testConfig());
			expect(snap.files.has("constitution.md")).toBe(true);
			expect(snap.files.has("persona.md")).toBe(true);
			expect(snap.files.has("user-profile.md")).toBe(true);
			expect(snap.files.has("strategies/task-patterns.md")).toBe(true);
			expect(snap.files.has("memory/corrections.md")).toBe(true);
		});

		test("snapshot excludes meta/ and .staging/", () => {
			mkdirSync(`${TEST_DIR}/.staging`, { recursive: true });
			writeFileSync(`${TEST_DIR}/.staging/batch-xyz.jsonl`, "{}\n", "utf-8");
			const snap = snapshotDirectory(testConfig());
			for (const key of snap.files.keys()) {
				expect(key.startsWith("meta/")).toBe(false);
				expect(key.startsWith(".staging/")).toBe(false);
			}
		});

		test("restore reverses a multi-file change", () => {
			const config = testConfig();
			const snap = snapshotDirectory(config);
			writeFileSync(`${TEST_DIR}/persona.md`, "mutated persona\n", "utf-8");
			writeFileSync(`${TEST_DIR}/user-profile.md`, "mutated profile\n", "utf-8");
			restoreSnapshot(config, snap);
			expect(readFileSync(`${TEST_DIR}/persona.md`, "utf-8")).toBe("# Persona\n\n- Be direct.\n");
			expect(readFileSync(`${TEST_DIR}/user-profile.md`, "utf-8")).toBe("# User Profile\n\n- Existing bullet.\n");
		});

		test("restore reverses a compaction (file shrinkage)", () => {
			const config = testConfig();
			writeFileSync(
				`${TEST_DIR}/user-profile.md`,
				["# User Profile", "", ...Array.from({ length: 40 }, (_, i) => `- bullet ${i}`)].join("\n"),
				"utf-8",
			);
			const snap = snapshotDirectory(config);
			// Simulate a compaction that shrinks the file
			writeFileSync(`${TEST_DIR}/user-profile.md`, "# User Profile\n\n- compacted.\n", "utf-8");
			expect(readFileSync(`${TEST_DIR}/user-profile.md`, "utf-8").split("\n").length).toBeLessThan(10);
			restoreSnapshot(config, snap);
			expect(readFileSync(`${TEST_DIR}/user-profile.md`, "utf-8").split("\n").length).toBeGreaterThan(30);
		});

		test("restore reverses new file creation by deleting the new file", () => {
			const config = testConfig();
			const snap = snapshotDirectory(config);
			writeFileSync(`${TEST_DIR}/strategies/new-strategy.md`, "# New\n", "utf-8");
			restoreSnapshot(config, snap);
			expect(existsSync(`${TEST_DIR}/strategies/new-strategy.md`)).toBe(false);
		});

		test("snapshot + restore + snapshot is byte-identical", () => {
			const config = testConfig();
			const snap1 = snapshotDirectory(config);
			restoreSnapshot(config, snap1);
			const snap2 = snapshotDirectory(config);
			expect(snap2.files.size).toBe(snap1.files.size);
			for (const [k, v] of snap1.files) {
				expect(snap2.files.get(k)).toBe(v);
			}
		});
	});

	describe("buildVersionChanges", () => {
		test("classifies edits, compactions, and new files from a sentinel", () => {
			const config = testConfig();
			const pre = snapshotDirectory(config);
			// Edit user-profile.md (add a line)
			writeFileSync(`${TEST_DIR}/user-profile.md`, "# User Profile\n\n- Existing bullet.\n- new bullet.\n", "utf-8");
			// Compact persona.md (simulate large pre -> small post)
			writeFileSync(`${TEST_DIR}/persona.md`, "# Persona\n", "utf-8");
			// New strategy file
			writeFileSync(`${TEST_DIR}/strategies/new-strategy.md`, "# New\n", "utf-8");
			const post = snapshotDirectory(config);

			const sentinel: SubprocessSentinel = {
				status: "ok",
				changes: [
					{ file: "user-profile.md", action: "edit", summary: "added context7 plugin note" },
					{ file: "persona.md", action: "compact", summary: "collapsed duplicates" },
					{ file: "strategies/new-strategy.md", action: "new", summary: "new deploy strategy" },
				],
			};
			const changes = buildVersionChanges(pre, post, sentinel, ["s1"], "drain=test");
			const byFile = new Map(changes.map((c) => [c.file, c]));
			expect(byFile.get("user-profile.md")?.type).toBe("edit");
			expect(byFile.get("persona.md")?.type).toBe("compact");
			expect(byFile.get("strategies/new-strategy.md")?.type).toBe("new");
			expect(byFile.get("user-profile.md")?.summary).toBe("added context7 plugin note");
		});
	});

	describe("migrateOldLogEntry / getEvolutionLog", () => {
		test("migrates an old-shape entry (singular session_id, append/remove, content) to the new shape", () => {
			// Representative old-shape row: singular session_id, details[].type
			// in append|replace|remove, details[].content. The migration helper
			// must up-convert this to drain_id + session_ids[] + tier + status
			// + details[].summary so downstream consumers see one shape.
			const raw = {
				timestamp: "2026-03-01T00:00:00Z",
				version: 12,
				session_id: "session-old-1",
				changes_applied: 2,
				changes_rejected: 0,
				details: [
					{
						file: "user-profile.md",
						type: "append",
						content: "User prefers TypeScript strict mode.",
						rationale: "observation from session",
						session_ids: ["session-old-1"],
					},
					{
						file: "memory/principles.md",
						type: "remove",
						content: "Outdated principle removed.",
						rationale: "superseded",
						session_ids: ["session-old-1"],
					},
				],
			};
			const migrated = migrateOldLogEntry(raw);
			expect(migrated).not.toBeNull();
			if (!migrated) return;
			expect(migrated.version).toBe(12);
			expect(migrated.session_ids).toEqual(["session-old-1"]);
			expect(migrated.drain_id).toBe("legacy-session-old-1");
			expect(migrated.tier).toBe("skip");
			expect(migrated.status).toBe("ok");
			expect(migrated.changes_applied).toBe(2);
			expect(migrated.details).toHaveLength(2);
			expect(migrated.details[0].type).toBe("edit");
			expect(migrated.details[0].summary).toBe("User prefers TypeScript strict mode.");
			expect(migrated.details[1].type).toBe("delete");
			expect(migrated.details[1].summary).toBe("Outdated principle removed.");
		});

		test("preserves a new-shape entry round-trip with no field loss", () => {
			const raw = {
				timestamp: "2026-04-14T10:00:00Z",
				version: 30,
				drain_id: "batch-abc-xyz",
				session_ids: ["s1", "s2"],
				tier: "sonnet",
				status: "ok",
				changes_applied: 1,
				details: [
					{
						file: "domain-knowledge.md",
						type: "edit",
						summary: "added rails 8 fact",
						rationale: "drain=batch-abc-xyz sessions=2",
						session_ids: ["s1", "s2"],
					},
				],
			};
			const migrated = migrateOldLogEntry(raw);
			expect(migrated).not.toBeNull();
			if (!migrated) return;
			expect(migrated.drain_id).toBe("batch-abc-xyz");
			expect(migrated.session_ids).toEqual(["s1", "s2"]);
			expect(migrated.tier).toBe("sonnet");
			expect(migrated.status).toBe("ok");
			expect(migrated.details[0].type).toBe("edit");
			expect(migrated.details[0].summary).toBe("added rails 8 fact");
		});

		test("getEvolutionLog reads a mixed file with both shapes interleaved", () => {
			const config = testConfig();
			const oldRow = {
				timestamp: "2026-03-01T00:00:00Z",
				version: 10,
				session_id: "old-1",
				details: [{ file: "persona.md", type: "replace", content: "tone tweak" }],
			};
			const newRow = {
				timestamp: "2026-04-14T10:00:00Z",
				version: 11,
				drain_id: "batch-new-1",
				session_ids: ["new-1"],
				tier: "haiku",
				status: "ok",
				changes_applied: 1,
				details: [{ file: "user-profile.md", type: "edit", summary: "new fact" }],
			};
			writeFileSync(config.paths.evolution_log, `${JSON.stringify(oldRow)}\n${JSON.stringify(newRow)}\n`, "utf-8");
			const entries = getEvolutionLog(config, 50);
			expect(entries).toHaveLength(2);
			expect(entries[0].version).toBe(10);
			expect(entries[0].details[0].type).toBe("edit"); // replace -> edit
			expect(entries[0].details[0].summary).toBe("tone tweak");
			expect(entries[1].version).toBe(11);
			expect(entries[1].drain_id).toBe("batch-new-1");
		});

		test("migrateOldLogEntry returns null on rows without a version field", () => {
			expect(migrateOldLogEntry({ timestamp: "x" })).toBeNull();
			expect(migrateOldLogEntry(null)).toBeNull();
			expect(migrateOldLogEntry("not an object")).toBeNull();
		});
	});
});

void join;
