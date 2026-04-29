import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { GateDecision } from "./gate-types.ts";
import type { SessionSummary } from "./types.ts";

// Phase 2 + 3 persistent queue. Sessions that passed `decideGate` live here
// until the cadence cron or the demand trigger drains them into
// `batch-processor.ts`. Phase 3 added `retry_count` for bounded retry on
// invariant hard fails and `evolution_queue_poison` for rows that exceed the
// retry ceiling so the operator can inspect them out of band.
//
// The CLI helper for the poison pile is deferred per locked decision 3;
// `listPoisonPile` ships so a future CLI PR can read it directly.

const POISON_RETRY_THRESHOLD = 3;

const GateSourceSchema = z.enum(["haiku", "failsafe"]);

const GateDecisionSchema: z.ZodType<GateDecision> = z.object({
	fire: z.boolean(),
	source: GateSourceSchema,
	reason: z.string(),
	haiku_cost_usd: z.number(),
});

const SessionSummarySchema: z.ZodType<SessionSummary> = z.object({
	session_id: z.string(),
	session_key: z.string(),
	user_id: z.string(),
	user_messages: z.array(z.string()),
	assistant_messages: z.array(z.string()),
	tools_used: z.array(z.string()),
	files_tracked: z.array(z.string()),
	outcome: z.enum(["success", "failure", "partial", "abandoned"]),
	cost_usd: z.number(),
	started_at: z.string(),
	ended_at: z.string(),
});

export type QueuedSession = {
	id: number;
	session_id: string;
	session_key: string;
	gate_decision: GateDecision;
	session_summary: SessionSummary;
	enqueued_at: string;
	retry_count: number;
};

export type PoisonedRow = {
	id: number;
	session_id: string;
	session_key: string;
	gate_decision: GateDecision;
	session_summary: SessionSummary;
	original_enqueued_at: string;
	poisoned_at: string;
	failure_reason: string | null;
};

type QueueRow = {
	id: number;
	session_id: string;
	session_key: string;
	gate_decision_json: string;
	session_summary_json: string;
	enqueued_at: string;
	retry_count: number;
};

type PoisonRow = {
	id: number;
	session_id: string;
	session_key: string;
	gate_decision_json: string;
	session_summary_json: string;
	original_enqueued_at: string;
	poisoned_at: string;
	failure_reason: string | null;
};

export class EvolutionQueue {
	constructor(private db: Database) {}

	enqueue(summary: SessionSummary, decision: GateDecision): void {
		const tx = this.db.transaction(
			(sessionKey: string, sessionId: string, decisionJson: string, summaryJson: string) => {
				this.db.run("DELETE FROM evolution_queue WHERE session_key = ?", [sessionKey]);
				this.db.run(
					`INSERT INTO evolution_queue (session_id, session_key, gate_decision_json, session_summary_json, retry_count)
				VALUES (?, ?, ?, ?, 0)`,
					[sessionId, sessionKey, decisionJson, summaryJson],
				);
			},
		);
		tx(summary.session_key, summary.session_id, JSON.stringify(decision), JSON.stringify(summary));
	}

	depth(): number {
		const row = this.db.query("SELECT COUNT(*) AS c FROM evolution_queue").get() as { c: number } | null;
		return row?.c ?? 0;
	}

	drainAll(): QueuedSession[] {
		const rows = this.db
			.query(
				"SELECT id, session_id, session_key, gate_decision_json, session_summary_json, enqueued_at, retry_count FROM evolution_queue ORDER BY enqueued_at ASC, id ASC",
			)
			.all() as QueueRow[];
		return rows.map((row) => parseRow(row));
	}

	markProcessed(ids: number[]): void {
		if (ids.length === 0) return;
		const placeholders = ids.map(() => "?").join(",");
		this.db.run(`DELETE FROM evolution_queue WHERE id IN (${placeholders})`, ids);
	}

	/**
	 * Increment `retry_count` on the given rows, optionally storing a
	 * per-row failure reason in the in-memory state (we do not persist the
	 * reason on the queue row itself because the evolution-log already
	 * carries the authoritative story). Rows whose post-increment count
	 * hits the poison threshold are moved to `evolution_queue_poison`
	 * atomically within the same transaction.
	 */
	markFailed(ids: number[], reasons?: Record<number, string>): { retried: number[]; poisoned: number[] } {
		if (ids.length === 0) return { retried: [], poisoned: [] };
		const retried: number[] = [];
		const poisoned: number[] = [];
		const tx = this.db.transaction((idList: number[]) => {
			for (const id of idList) {
				const row = this.db
					.query(
						"SELECT id, session_id, session_key, gate_decision_json, session_summary_json, enqueued_at, retry_count FROM evolution_queue WHERE id = ?",
					)
					.get(id) as QueueRow | null;
				if (!row) continue;
				const nextCount = row.retry_count + 1;
				if (nextCount >= POISON_RETRY_THRESHOLD) {
					const reason = reasons?.[id] ?? null;
					this.db.run(
						`INSERT INTO evolution_queue_poison (session_id, session_key, gate_decision_json, session_summary_json, original_enqueued_at, failure_reason)
						VALUES (?, ?, ?, ?, ?, ?)`,
						[
							row.session_id,
							row.session_key,
							row.gate_decision_json,
							row.session_summary_json,
							row.enqueued_at,
							reason,
						],
					);
					this.db.run("DELETE FROM evolution_queue WHERE id = ?", [id]);
					poisoned.push(id);
				} else {
					this.db.run("UPDATE evolution_queue SET retry_count = ? WHERE id = ?", [nextCount, id]);
					retried.push(id);
				}
			}
		});
		tx(ids);
		return { retried, poisoned };
	}

	/**
	 * Atomically move a set of rows to the poison pile regardless of their
	 * current retry count. Used when a row's failure reason indicates the
	 * operator should not keep retrying (e.g. a hard credential leak).
	 */
	moveToPoisonPile(ids: number[], reasons?: Record<number, string>): number {
		if (ids.length === 0) return 0;
		let moved = 0;
		const tx = this.db.transaction((idList: number[]) => {
			for (const id of idList) {
				const row = this.db
					.query(
						"SELECT id, session_id, session_key, gate_decision_json, session_summary_json, enqueued_at, retry_count FROM evolution_queue WHERE id = ?",
					)
					.get(id) as QueueRow | null;
				if (!row) continue;
				const reason = reasons?.[id] ?? null;
				this.db.run(
					`INSERT INTO evolution_queue_poison (session_id, session_key, gate_decision_json, session_summary_json, original_enqueued_at, failure_reason)
					VALUES (?, ?, ?, ?, ?, ?)`,
					[row.session_id, row.session_key, row.gate_decision_json, row.session_summary_json, row.enqueued_at, reason],
				);
				this.db.run("DELETE FROM evolution_queue WHERE id = ?", [id]);
				moved += 1;
			}
		});
		tx(ids);
		return moved;
	}

	/**
	 * Return every row in the poison pile. The CLI helper that will consume
	 * this ships in a follow-up PR per locked decision 3; the method lives
	 * here today because the reflection subprocess path needs the plumbing
	 * to exist and because tests assert against it.
	 */
	listPoisonPile(): PoisonedRow[] {
		const rows = this.db
			.query(
				"SELECT id, session_id, session_key, gate_decision_json, session_summary_json, original_enqueued_at, poisoned_at, failure_reason FROM evolution_queue_poison ORDER BY poisoned_at DESC, id DESC",
			)
			.all() as PoisonRow[];
		return rows.map((row) => ({
			id: row.id,
			session_id: row.session_id,
			session_key: row.session_key,
			gate_decision: GateDecisionSchema.parse(JSON.parse(row.gate_decision_json)),
			session_summary: SessionSummarySchema.parse(JSON.parse(row.session_summary_json)),
			original_enqueued_at: row.original_enqueued_at,
			poisoned_at: row.poisoned_at,
			failure_reason: row.failure_reason,
		}));
	}

	/** Test-only: truncate the queue between assertions. */
	clear(): void {
		this.db.run("DELETE FROM evolution_queue");
		this.db.run("DELETE FROM evolution_queue_poison");
	}
}

function parseRow(row: QueueRow): QueuedSession {
	const decisionRaw: unknown = JSON.parse(row.gate_decision_json);
	const summaryRaw: unknown = JSON.parse(row.session_summary_json);
	const decision = GateDecisionSchema.parse(decisionRaw);
	const summary = SessionSummarySchema.parse(summaryRaw);
	return {
		id: row.id,
		session_id: row.session_id,
		session_key: row.session_key,
		gate_decision: decision,
		session_summary: summary,
		enqueued_at: row.enqueued_at,
		retry_count: row.retry_count ?? 0,
	};
}
