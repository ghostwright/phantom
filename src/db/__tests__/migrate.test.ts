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
		expect(tables).toContain("loops");
		expect(tables).toContain("_migrations");
	});

	test("is idempotent - running twice does not fail", () => {
		const db = freshDb();
		runMigrations(db);
		runMigrations(db);

		const migrationCount = db.query("SELECT COUNT(*) as count FROM _migrations").get() as { count: number };
		expect(migrationCount.count).toBe(18);
	});

	test("tracks applied migration indices", () => {
		const db = freshDb();
		runMigrations(db);

		const indices = db
			.query("SELECT index_num FROM _migrations ORDER BY index_num")
			.all()
			.map((r) => (r as { index_num: number }).index_num);

		expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
	});
});
