/**
 * Phase 18 PR-6: migration-safety CI gate entry point.
 *
 * Run via `bun run src/db/check-migrations.ts`. Walks every migration string
 * in `src/db/schema.ts` and checks each against the additive + idempotent
 * contract. Exits non-zero with a human-readable violation list if any
 * migration breaks the contract; exits 0 silently otherwise.
 *
 * The contract and rationale live in `migration-safety.ts`. The full
 * architectural argument is in
 * `phantom-cloud-deploy/local/2026-05-01-phase18-phantom-updates-flow-architect.md`
 * §5.2 (the Phase 18 architect doc, private).
 */

import { checkMigrations, formatViolations } from "./migration-safety.ts";

function main(): void {
	const violations = checkMigrations();
	if (violations.length === 0) {
		console.log("migration-safety: ok");
		return;
	}
	console.error(formatViolations(violations));
	process.exit(1);
}

main();
