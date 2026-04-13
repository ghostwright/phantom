import type { Database } from "bun:sqlite";
import type { JobRow } from "./types.ts";

/**
 * Stagger used to space out missed-job fires after a restart. The first
 * missed job fires immediately, each subsequent job fires STAGGER_MS later.
 * The scheduler's onTimer loop naturally picks them up in next_run_at order.
 */
export const MISSED_JOB_STAGGER_MS = 5_000;

export type StaggerResult = {
	count: number;
	firstFireAt: string | null;
	lastFireAt: string | null;
};

/**
 * Rewrite next_run_at on every past-due active job so the normal onTimer loop
 * will pick them up in sequence. Replaces the old blocking sequential recovery
 * loop that held up server boot for minutes (M1). This function does zero
 * awaits: it is a pure SQL rewrite that returns as soon as the update is done.
 */
export function staggerMissedJobs(db: Database, nowMs: number = Date.now()): StaggerResult {
	const nowIso = new Date(nowMs).toISOString();
	const missedRows = db
		.query(
			"SELECT id, name FROM scheduled_jobs WHERE enabled = 1 AND status = 'active' AND next_run_at < ? ORDER BY next_run_at ASC",
		)
		.all(nowIso) as Pick<JobRow, "id" | "name">[];

	if (missedRows.length === 0) {
		return { count: 0, firstFireAt: null, lastFireAt: null };
	}

	const update = db.prepare("UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?");
	let firstFireAt: string | null = null;
	let lastFireAt: string | null = null;

	for (let i = 0; i < missedRows.length; i++) {
		const fireAt = new Date(nowMs + i * MISSED_JOB_STAGGER_MS).toISOString();
		update.run(fireAt, missedRows[i].id);
		if (i === 0) firstFireAt = fireAt;
		lastFireAt = fireAt;
	}

	console.log(
		`[scheduler] Staggered ${missedRows.length} missed job(s) for recovery ` +
			`(first fire ${firstFireAt}, last fire ${lastFireAt})`,
	);

	return { count: missedRows.length, firstFireAt, lastFireAt };
}

/**
 * Delete terminal rows older than the TTL. Rows marked deleteAfterRun are
 * removed inline by executeJob, so this sweep only catches completed/failed
 * jobs that were created without that flag. Runs once per start(). See N5.
 */
export function cleanupOldTerminalJobs(db: Database, ttlDays = 30): number {
	const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
	const result = db.run(
		"DELETE FROM scheduled_jobs WHERE status IN ('completed', 'failed') AND delete_after_run = 0 AND updated_at < ?",
		[cutoff],
	);
	if (result.changes > 0) {
		console.log(`[scheduler] Cleanup swept ${result.changes} terminal row(s) older than ${ttlDays} days`);
	}
	return result.changes;
}
