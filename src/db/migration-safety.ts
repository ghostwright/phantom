import { MIGRATIONS } from "./schema.ts";

/**
 * Phase 18 PR-6: migration-safety gate.
 *
 * Phantom's tenants survive an upgrade by having their `/app/data/`
 * directory rsynced from the old ZFS clone to the new clone (Phase 18
 * architect §5.1). The SQLite file at `/app/data/phantom.sqlite` carries
 * forward, including the `_migrations` index table. When the new phantom
 * code boots in the new clone, `runMigrations` runs only the new entries.
 *
 * For this to be safe, every migration MUST be:
 *
 * 1. **Additive.** No `DROP TABLE`, no `DROP COLUMN`, no
 *    `ALTER TABLE ... DROP CONSTRAINT`, no column renames. Removing or
 *    renaming columns breaks the previous version's reads of the existing
 *    data, which breaks the rollback-safety invariant (architect §5.2).
 * 2. **Idempotent.** Running the same migration twice is the same as
 *    running it once. New tables and indexes use `CREATE ... IF NOT
 *    EXISTS`. SQLite's `ALTER TABLE ... ADD COLUMN` does not have an
 *    `IF NOT EXISTS` clause, but the `_migrations` table makes the step
 *    idempotent at the runner level (an already-applied index_num is
 *    skipped).
 *
 * The contract is enforced as a CI gate. The gate walks the `MIGRATIONS`
 * array, parses each statement, and rejects the PR if any violation is
 * found. Invoke from CI via `bun run scripts/check-migrations.ts`.
 *
 * The gate is intentionally conservative: it blocks the patterns that
 * have known-bad outcomes for the upgrade flow. It does not attempt to
 * be a SQL parser. False positives are a feature, not a bug; an operator
 * who needs a forbidden pattern must explicitly opt in (architect §5.2).
 */

export type MigrationViolation = {
	index: number;
	statement: string;
	rule: string;
	detail: string;
};

const FORBIDDEN_PATTERNS: ReadonlyArray<{ rule: string; pattern: RegExp; detail: string }> = [
	{
		rule: "no_drop_table",
		pattern: /\bDROP\s+TABLE\b/i,
		detail:
			"DROP TABLE is forbidden because it deletes data the previous phantom version may still read, breaking rollback safety. To deprecate a table, leave it and mark it unused in code.",
	},
	{
		rule: "no_drop_column",
		pattern: /\bDROP\s+COLUMN\b/i,
		detail:
			"DROP COLUMN is forbidden because the previous phantom version's SELECTs against the column would fail after rollback. Leave the column in place and stop writing to it in code.",
	},
	{
		rule: "no_drop_constraint",
		pattern: /\bDROP\s+CONSTRAINT\b/i,
		detail:
			"ALTER TABLE ... DROP CONSTRAINT is forbidden because it changes the data shape in a way the previous phantom version cannot recover from after rollback.",
	},
	{
		rule: "no_drop_index",
		pattern: /\bDROP\s+INDEX\b/i,
		detail:
			"DROP INDEX is forbidden because it can change query plans in ways the previous version did not anticipate. Leave the index in place; if it is unused, the cost is negligible.",
	},
	{
		rule: "no_rename_column",
		pattern: /\bRENAME\s+COLUMN\b/i,
		detail:
			"RENAME COLUMN is forbidden because it breaks the previous phantom version's column references. Add a new column with the desired name, write to both, and remove the old column reads in a later version.",
	},
	{
		rule: "no_rename_table",
		pattern: /\bRENAME\s+TO\b/i,
		detail:
			"ALTER TABLE ... RENAME TO is forbidden for the same reason as RENAME COLUMN. Keep the original name; create a new table if the schema needs to evolve.",
	},
];

/**
 * Strip SQL line comments (`-- ...`) so they do not trigger pattern matches.
 * Block comments are not used in phantom's migrations today; if introduced
 * later, extend this stripper accordingly.
 */
function stripComments(statement: string): string {
	return statement
		.split("\n")
		.map((line) => {
			const idx = line.indexOf("--");
			return idx >= 0 ? line.slice(0, idx) : line;
		})
		.join("\n");
}

/**
 * Detect patterns that indicate non-idempotent statements. SQLite's only
 * idempotent forms for table/index creation are CREATE ... IF NOT EXISTS.
 * ALTER TABLE ADD COLUMN is allowed without IF NOT EXISTS because the
 * `_migrations` table gates re-execution at the runner level.
 */
function checkIdempotency(statement: string, index: number): MigrationViolation[] {
	const cleaned = stripComments(statement).trim();
	const upper = cleaned.toUpperCase();
	const violations: MigrationViolation[] = [];

	if (/\bCREATE\s+TABLE\b/.test(upper) && !/\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/.test(upper)) {
		violations.push({
			index,
			statement,
			rule: "create_table_must_be_idempotent",
			detail:
				"CREATE TABLE must use IF NOT EXISTS so the migration step can run on a database that already has the table (e.g. the runner's _migrations gate is bypassed during recovery).",
		});
	}

	if (/\bCREATE\b/.test(upper) && /\bINDEX\b/.test(upper) && !/\bIF\s+NOT\s+EXISTS\b/.test(upper)) {
		violations.push({
			index,
			statement,
			rule: "create_index_must_be_idempotent",
			detail: "CREATE INDEX (and CREATE UNIQUE INDEX) must use IF NOT EXISTS for the same reason as CREATE TABLE.",
		});
	}

	return violations;
}

/**
 * Validate a single migration statement against the additive + idempotent
 * contract. Returns an empty array if the statement is clean.
 */
export function validateMigration(statement: string, index: number): MigrationViolation[] {
	const violations: MigrationViolation[] = [];
	const cleaned = stripComments(statement);

	for (const { rule, pattern, detail } of FORBIDDEN_PATTERNS) {
		if (pattern.test(cleaned)) {
			violations.push({ index, statement, rule, detail });
		}
	}

	violations.push(...checkIdempotency(statement, index));

	return violations;
}

/**
 * Walk every migration string in `MIGRATIONS` and collect every violation.
 * The CI gate fails the build if the returned array is non-empty.
 */
export function checkMigrations(statements: ReadonlyArray<string> = MIGRATIONS): MigrationViolation[] {
	const violations: MigrationViolation[] = [];
	for (let i = 0; i < statements.length; i++) {
		violations.push(...validateMigration(statements[i], i));
	}
	return violations;
}

/**
 * Format a violation list as a human-readable error block for the CI log.
 */
export function formatViolations(violations: ReadonlyArray<MigrationViolation>): string {
	if (violations.length === 0) {
		return "";
	}

	const lines: string[] = [`Migration-safety gate found ${violations.length} violation(s):`, ""];
	for (const v of violations) {
		const preview = v.statement.replace(/\s+/g, " ").trim().slice(0, 160);
		lines.push(`- migration[${v.index}] rule=${v.rule}`);
		lines.push(`  statement: ${preview}${preview.length === 160 ? "..." : ""}`);
		lines.push(`  detail:    ${v.detail}`);
		lines.push("");
	}
	lines.push("All phantom migrations must be additive (no DROP, no RENAME) and idempotent (CREATE ... IF NOT EXISTS).");
	lines.push(
		"See phantom-cloud-deploy/local/2026-05-01-phase18-phantom-updates-flow-architect.md §5.2 for the full contract.",
	);
	return lines.join("\n");
}
