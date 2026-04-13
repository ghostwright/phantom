import type { Database } from "bun:sqlite";

export type SchedulerHealthSummary = {
	total: number;
	active: number;
	paused: number;
	completed: number;
	failed: number;
	nextFireAt: string | null;
	recentFailures: number;
};

/**
 * Minimal health snapshot for the /health endpoint (M5). All reads are
 * indexed or small aggregates so the cost is bounded regardless of job count.
 */
export function computeHealthSummary(db: Database): SchedulerHealthSummary {
	const statusRows = db.query("SELECT status, COUNT(*) as c FROM scheduled_jobs GROUP BY status").all() as {
		status: string;
		c: number;
	}[];

	const counts = { active: 0, paused: 0, completed: 0, failed: 0 };
	let total = 0;
	for (const row of statusRows) {
		total += row.c;
		if (row.status in counts) counts[row.status as keyof typeof counts] = row.c;
	}

	const nextRow = db
		.query(
			"SELECT MIN(next_run_at) as next FROM scheduled_jobs WHERE enabled = 1 AND status = 'active' AND next_run_at IS NOT NULL",
		)
		.get() as { next: string | null } | null;

	const failRow = db
		.query("SELECT COUNT(*) as c FROM scheduled_jobs WHERE consecutive_errors > 0 AND status = 'active'")
		.get() as { c: number };

	return {
		total,
		active: counts.active,
		paused: counts.paused,
		completed: counts.completed,
		failed: counts.failed,
		nextFireAt: nextRow?.next ?? null,
		recentFailures: failRow.c,
	};
}
