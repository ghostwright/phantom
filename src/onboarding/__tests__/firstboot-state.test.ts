import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../db/migrate.ts";
import { getFirstbootState, isIntroSent, markIntroSent } from "../state.ts";

describe("Phase 12 firstboot state", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA foreign_keys = ON");
		runMigrations(db);
	});

	afterEach(() => {
		db.close();
	});

	test("default state has nothing set", () => {
		const state = getFirstbootState(db);
		expect(state.intro_sent_at).toBeNull();
		expect(state.research_outcome).toBeNull();
		expect(isIntroSent(db)).toBe(false);
	});

	test("markIntroSent stores the outcome and timestamp", () => {
		markIntroSent(db, "ok");
		const state = getFirstbootState(db);
		expect(state.intro_sent_at).not.toBeNull();
		expect(state.research_outcome).toBe("ok");
		expect(isIntroSent(db)).toBe(true);
	});

	test("markIntroSent is idempotent on the timestamp", () => {
		markIntroSent(db, "ok");
		const first = getFirstbootState(db).intro_sent_at;
		markIntroSent(db, "ok");
		const second = getFirstbootState(db).intro_sent_at;
		expect(second).toBe(first);
	});

	test("markIntroSent updates the outcome on later call but preserves timestamp", () => {
		markIntroSent(db, "empty");
		const stamp1 = getFirstbootState(db).intro_sent_at;
		markIntroSent(db, "ok");
		const stamp2 = getFirstbootState(db).intro_sent_at;
		expect(stamp2).toBe(stamp1);
		expect(getFirstbootState(db).research_outcome).toBe("ok");
	});

	test("only one row exists after multiple calls", () => {
		markIntroSent(db, "ok");
		markIntroSent(db, "timeout");
		markIntroSent(db, "ok");
		const rows = db.query("SELECT * FROM firstboot_state").all();
		expect(rows).toHaveLength(1);
	});

	test("CHECK constraint enforces id = 1", () => {
		expect(() => {
			db.run("INSERT INTO firstboot_state (id) VALUES (2)");
		}).toThrow();
	});
});
