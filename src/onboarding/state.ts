import type { Database } from "bun:sqlite";

export type OnboardingStatus = "pending" | "in_progress" | "complete";

export type OnboardingRecord = {
	status: OnboardingStatus;
	started_at: string | null;
	completed_at: string | null;
};

export function getOnboardingStatus(db: Database): OnboardingRecord {
	const row = db
		.query("SELECT status, started_at, completed_at FROM onboarding_state ORDER BY id DESC LIMIT 1")
		.get() as OnboardingRecord | null;

	return row ?? { status: "pending", started_at: null, completed_at: null };
}

export function markOnboardingStarted(db: Database): void {
	const existing = getOnboardingStatus(db);
	if (existing.status === "in_progress") return;

	db.run("INSERT INTO onboarding_state (status, started_at) VALUES (?, datetime('now'))", ["in_progress"]);
}

export function markOnboardingComplete(db: Database): void {
	db.run(
		`UPDATE onboarding_state SET status = 'complete', completed_at = datetime('now')
		 WHERE status = 'in_progress'`,
	);
}

// Phase 12 idempotency state: a single-row firstboot ledger that records
// whether the intro DM has gone out and what the research outcome was.
// We pin id=1 with a CHECK so the table behaves as a singleton; the
// first insert and every later upsert touch the same row. This closes
// the LOW bug at phantom CLAUDE.md:284 where the intro DM re-fired on
// every restart while evolution generation stayed at 0.

export type FirstbootState = {
	intro_sent_at: string | null;
	research_outcome: string | null;
};

export function getFirstbootState(db: Database): FirstbootState {
	const row = db
		.query("SELECT intro_sent_at, research_outcome FROM firstboot_state WHERE id = 1")
		.get() as FirstbootState | null;
	return row ?? { intro_sent_at: null, research_outcome: null };
}

/** True when the intro DM has already been sent successfully. The
 * firstboot path checks this BEFORE running research or sending the DM. */
export function isIntroSent(db: Database): boolean {
	return getFirstbootState(db).intro_sent_at !== null;
}

/** Mark the intro DM as sent. Idempotent: the upsert preserves the
 * original intro_sent_at on the second call so we keep the truthful
 * first-time record. The research_outcome is allowed to be updated on a
 * later call so a poison-pill empty research can be replaced by a later
 * successful run; the timestamp itself is immutable once set. */
export function markIntroSent(db: Database, researchOutcome: string): void {
	db.run(
		`INSERT INTO firstboot_state (id, intro_sent_at, research_outcome)
		 VALUES (1, datetime('now'), ?)
		 ON CONFLICT(id) DO UPDATE SET research_outcome = excluded.research_outcome`,
		[researchOutcome],
	);
}
