import { describe, expect, test } from "bun:test";
import { checkMigrations, formatViolations, validateMigration } from "../migration-safety.ts";
import { MIGRATIONS } from "../schema.ts";

/**
 * Phase 18 PR-6: migration-safety gate coverage.
 *
 * The gate enforces the additive + idempotent contract documented in
 * `migration-safety.ts`. Coverage proves the rules fire on bad migrations,
 * pass on good ones, and that the live `MIGRATIONS` array in `schema.ts`
 * is currently clean.
 */
describe("validateMigration", () => {
	test("flags DROP TABLE", () => {
		const v = validateMigration("DROP TABLE legacy_tenants", 0);
		expect(v.length).toBe(1);
		expect(v[0].rule).toBe("no_drop_table");
	});

	test("flags lowercase drop table", () => {
		const v = validateMigration("drop table legacy_tenants", 0);
		expect(v.length).toBe(1);
		expect(v[0].rule).toBe("no_drop_table");
	});

	test("flags ALTER TABLE ... DROP COLUMN", () => {
		const v = validateMigration("ALTER TABLE sessions DROP COLUMN legacy_field", 0);
		expect(v.length).toBe(1);
		expect(v[0].rule).toBe("no_drop_column");
	});

	test("flags DROP CONSTRAINT", () => {
		const v = validateMigration("ALTER TABLE sessions DROP CONSTRAINT pk_sessions", 0);
		expect(v.length).toBe(1);
		expect(v[0].rule).toBe("no_drop_constraint");
	});

	test("flags DROP INDEX", () => {
		const v = validateMigration("DROP INDEX idx_sessions_key", 0);
		expect(v.length).toBe(1);
		expect(v[0].rule).toBe("no_drop_index");
	});

	test("flags ALTER TABLE ... RENAME COLUMN", () => {
		const v = validateMigration("ALTER TABLE sessions RENAME COLUMN old_name TO new_name", 0);
		expect(v.length).toBeGreaterThanOrEqual(1);
		expect(v.some((x) => x.rule === "no_rename_column")).toBe(true);
	});

	test("flags ALTER TABLE ... RENAME TO", () => {
		const v = validateMigration("ALTER TABLE sessions RENAME TO sessions_legacy", 0);
		expect(v.some((x) => x.rule === "no_rename_table")).toBe(true);
	});

	test("flags CREATE TABLE without IF NOT EXISTS", () => {
		const v = validateMigration("CREATE TABLE foo (id INTEGER PRIMARY KEY)", 0);
		expect(v.length).toBe(1);
		expect(v[0].rule).toBe("create_table_must_be_idempotent");
	});

	test("flags CREATE INDEX without IF NOT EXISTS", () => {
		const v = validateMigration("CREATE INDEX idx_foo_id ON foo(id)", 0);
		expect(v.length).toBe(1);
		expect(v[0].rule).toBe("create_index_must_be_idempotent");
	});

	test("flags CREATE UNIQUE INDEX without IF NOT EXISTS", () => {
		const v = validateMigration("CREATE UNIQUE INDEX idx_foo_id ON foo(id)", 0);
		expect(v.length).toBe(1);
		expect(v[0].rule).toBe("create_index_must_be_idempotent");
	});

	test("passes a clean CREATE TABLE IF NOT EXISTS", () => {
		const v = validateMigration("CREATE TABLE IF NOT EXISTS foo (id INTEGER PRIMARY KEY)", 0);
		expect(v.length).toBe(0);
	});

	test("passes CREATE INDEX IF NOT EXISTS", () => {
		const v = validateMigration("CREATE INDEX IF NOT EXISTS idx_foo_id ON foo(id)", 0);
		expect(v.length).toBe(0);
	});

	test("passes ALTER TABLE ADD COLUMN (idempotency comes from _migrations gate)", () => {
		const v = validateMigration("ALTER TABLE sessions ADD COLUMN new_field TEXT", 0);
		expect(v.length).toBe(0);
	});

	test("passes DELETE FROM data cleanup (no schema change)", () => {
		const v = validateMigration("DELETE FROM dynamic_tools WHERE handler_type = 'inline'", 0);
		expect(v.length).toBe(0);
	});

	test("ignores forbidden tokens that appear inside SQL line comments", () => {
		const v = validateMigration(
			"-- DROP TABLE was considered but rejected\nCREATE TABLE IF NOT EXISTS foo (id INTEGER PRIMARY KEY)",
			0,
		);
		expect(v.length).toBe(0);
	});
});

describe("checkMigrations", () => {
	test("the live MIGRATIONS array passes the gate", () => {
		const violations = checkMigrations();
		expect(violations).toEqual([]);
	});

	test("MIGRATIONS array contains the expected count of statements (regression: schema.ts size)", () => {
		// 51 entries as of Phase 10 PR 10-3. New entries push this number up;
		// the test exists to flag accidental truncation, not to gate growth.
		expect(MIGRATIONS.length).toBeGreaterThanOrEqual(51);
	});

	test("returns every violation across multiple bad statements", () => {
		const fixture = [
			"CREATE TABLE IF NOT EXISTS good (id INTEGER PRIMARY KEY)",
			"DROP TABLE bad_one",
			"CREATE TABLE bad_two (id INTEGER)",
			"ALTER TABLE good DROP COLUMN id",
		];
		const violations = checkMigrations(fixture);
		expect(violations.length).toBe(3);
		expect(violations.map((v) => v.rule).sort()).toEqual([
			"create_table_must_be_idempotent",
			"no_drop_column",
			"no_drop_table",
		]);
		expect(violations.find((v) => v.rule === "no_drop_table")?.index).toBe(1);
		expect(violations.find((v) => v.rule === "create_table_must_be_idempotent")?.index).toBe(2);
		expect(violations.find((v) => v.rule === "no_drop_column")?.index).toBe(3);
	});
});

describe("formatViolations", () => {
	test("returns empty string for an empty list", () => {
		expect(formatViolations([])).toBe("");
	});

	test("includes rule names, indices, and detail text in the output", () => {
		const formatted = formatViolations([
			{ index: 7, statement: "DROP TABLE foo", rule: "no_drop_table", detail: "reason here" },
		]);
		expect(formatted).toContain("migration[7]");
		expect(formatted).toContain("rule=no_drop_table");
		expect(formatted).toContain("DROP TABLE foo");
		expect(formatted).toContain("reason here");
	});
});
