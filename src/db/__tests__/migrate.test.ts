import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runMigrations } from "../migrate.ts";

function freshDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	return db;
}

describe("runMigrations", () => {
	test("creates sessions, cost_events, onboarding_state, dynamic_tools, and scheduled_jobs tables", () => {
		const db = freshDb();
		runMigrations(db);

		const tables = db
			.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all()
			.map((r) => (r as { name: string }).name);

		expect(tables).toContain("sessions");
		expect(tables).toContain("cost_events");
		expect(tables).toContain("onboarding_state");
		expect(tables).toContain("dynamic_tools");
		expect(tables).toContain("scheduled_jobs");
		expect(tables).toContain("secrets");
		expect(tables).toContain("secret_requests");
		expect(tables).toContain("_migrations");
	});

	test("is idempotent - running twice does not fail", () => {
		const db = freshDb();
		runMigrations(db);
		runMigrations(db);

		const migrationCount = db.query("SELECT COUNT(*) as count FROM _migrations").get() as { count: number };
		// PR3 adds three audit tables and their indices: subagent_audit_log
		// (commit 3), hook_audit_log (commit 4), and settings_audit_log
		// (commit 5). Each adds 2 migration steps (table + index), bringing
		// the total from the PR2 baseline of 16 up to 22. The PR3 fix pass
		// appends two ALTER TABLE statements on subagent_audit_log to add
		// previous_frontmatter_json and new_frontmatter_json columns,
		// bringing the total to 24.
		expect(migrationCount.count).toBe(24);
	});

	test("tracks applied migration indices", () => {
		const db = freshDb();
		runMigrations(db);

		const indices = db
			.query("SELECT index_num FROM _migrations ORDER BY index_num")
			.all()
			.map((r) => (r as { index_num: number }).index_num);

		expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
	});

	test("subagent_audit_log has frontmatter JSON columns after migration", () => {
		const db = freshDb();
		runMigrations(db);
		const cols = db
			.query("PRAGMA table_info(subagent_audit_log)")
			.all()
			.map((r) => (r as { name: string }).name);
		expect(cols).toContain("previous_frontmatter_json");
		expect(cols).toContain("new_frontmatter_json");
	});
});
