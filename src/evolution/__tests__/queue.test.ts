import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import type { GateDecision } from "../gate-types.ts";
import { EvolutionQueue } from "../queue.ts";
import type { SessionSummary } from "../types.ts";

// Phase 2 queue tests. Cover SQLite migration, enqueue persistence, drain
// ordering, markProcessed, Zod schema validation on read, and the
// process-restart survival case that justifies the SQLite backing in the
// first place.

function newDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	for (const stmt of MIGRATIONS) {
		db.run(stmt);
	}
	return db;
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		session_id: "s1",
		session_key: "slack:C1:T1",
		user_id: "u1",
		user_messages: ["help me"],
		assistant_messages: ["sure"],
		tools_used: ["Read"],
		files_tracked: [],
		outcome: "success",
		cost_usd: 0.05,
		started_at: "2026-04-14T10:00:00Z",
		ended_at: "2026-04-14T10:03:00Z",
		...overrides,
	};
}

const DECISION: GateDecision = {
	fire: true,
	source: "haiku",
	reason: "user taught a workflow pattern",
	haiku_cost_usd: 0.0006,
};

describe("EvolutionQueue", () => {
	let db: Database;

	beforeEach(() => {
		db = newDb();
	});

	test("migration created the evolution_queue table", () => {
		const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='evolution_queue'").get() as {
			name: string;
		} | null;
		expect(row).not.toBeNull();
		expect(row?.name).toBe("evolution_queue");
	});

	test("enqueue inserts a row and depth reflects the insert", () => {
		const queue = new EvolutionQueue(db);
		expect(queue.depth()).toBe(0);
		queue.enqueue(makeSummary(), DECISION);
		expect(queue.depth()).toBe(1);
	});

	test("drainAll returns rows oldest-first", () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "a", session_key: "slack:Ca:Ta" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "b", session_key: "slack:Cb:Tb" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "c", session_key: "slack:Cc:Tc" }), DECISION);
		const drained = queue.drainAll();
		expect(drained).toHaveLength(3);
		expect(drained[0].session_id).toBe("a");
		expect(drained[1].session_id).toBe("b");
		expect(drained[2].session_id).toBe("c");
	});

	test("drainAll returns empty array on empty queue", () => {
		const queue = new EvolutionQueue(db);
		expect(queue.drainAll()).toHaveLength(0);
	});

	test("markProcessed deletes only the specified ids", () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "a", session_key: "slack:Ca:Ta" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "b", session_key: "slack:Cb:Tb" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "c", session_key: "slack:Cc:Tc" }), DECISION);
		const drained = queue.drainAll();
		queue.markProcessed([drained[0].id, drained[2].id]);
		const remaining = queue.drainAll();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].session_id).toBe("b");
	});

	test("Zod validates the decoded gate decision and session summary", () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary(), DECISION);
		const drained = queue.drainAll();
		expect(drained[0].gate_decision.fire).toBe(true);
		expect(drained[0].gate_decision.source).toBe("haiku");
		expect(drained[0].session_summary.user_messages).toEqual(["help me"]);
	});

	test("row survives a reopened database connection", () => {
		// SQLite in-memory databases do not persist across connections, so we
		// use a shared `:memory:?cache=shared` style via an explicit file path
		// that lives for the duration of the test.
		const path = `/tmp/phantom-test-queue-${process.pid}-${Date.now()}.sqlite`;
		try {
			const db1 = new Database(path, { create: true });
			for (const stmt of MIGRATIONS) db1.run(stmt);
			const q1 = new EvolutionQueue(db1);
			q1.enqueue(makeSummary({ session_id: "survivor" }), DECISION);
			db1.close();

			const db2 = new Database(path);
			const q2 = new EvolutionQueue(db2);
			const rows = q2.drainAll();
			expect(rows).toHaveLength(1);
			expect(rows[0].session_id).toBe("survivor");
			db2.close();
		} finally {
			try {
				require("node:fs").rmSync(path, { force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	test("enqueueing the same session_key twice keeps only the latest summary", () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(
			makeSummary({
				session_id: "turn-3",
				session_key: "slack:C1:T1",
				user_messages: ["short turn 3"],
			}),
			DECISION,
		);
		queue.enqueue(
			makeSummary({
				session_id: "turn-15",
				session_key: "slack:C1:T1",
				user_messages: ["full conversation up through turn 15"],
				cost_usd: 0.42,
			}),
			DECISION,
		);
		expect(queue.depth()).toBe(1);
		const drained = queue.drainAll();
		expect(drained).toHaveLength(1);
		// The most recent enqueue wins. Without dedup, a busy multi-turn
		// session would burn the full Sonnet judge pipeline once per turn that
		// crossed the gate, against progressively shorter snapshots of the
		// same conversation.
		expect(drained[0].session_id).toBe("turn-15");
		expect(drained[0].session_summary.user_messages).toEqual(["full conversation up through turn 15"]);
		expect(drained[0].session_summary.cost_usd).toBeCloseTo(0.42, 5);
	});

	test("dedup is scoped per session_key, not per session_id", () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "a", session_key: "slack:C1:T1" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "b", session_key: "slack:C2:T2" }), DECISION);
		queue.enqueue(makeSummary({ session_id: "c", session_key: "slack:C1:T1" }), DECISION);
		expect(queue.depth()).toBe(2);
		const drained = queue.drainAll();
		const keys = drained.map((d) => d.session_key).sort();
		expect(keys).toEqual(["slack:C1:T1", "slack:C2:T2"]);
		const c1Row = drained.find((d) => d.session_key === "slack:C1:T1");
		expect(c1Row?.session_id).toBe("c");
	});

	test("clear truncates the queue", () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary(), DECISION);
		queue.enqueue(makeSummary(), DECISION);
		queue.clear();
		expect(queue.depth()).toBe(0);
	});

	test("Phase 3: markFailed increments retry_count", () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "r1", session_key: "slack:Cr1:Tr1" }), DECISION);
		const drained1 = queue.drainAll();
		expect(drained1[0].retry_count).toBe(0);

		const disposition = queue.markFailed([drained1[0].id], { [drained1[0].id]: "I1: bad scope" });
		expect(disposition.retried).toEqual([drained1[0].id]);
		expect(disposition.poisoned).toEqual([]);

		const drained2 = queue.drainAll();
		expect(drained2).toHaveLength(1);
		expect(drained2[0].retry_count).toBe(1);
	});

	test("Phase 3: three markFailed calls move the row to poison", () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "r2", session_key: "slack:Cr2:Tr2" }), DECISION);
		let row = queue.drainAll()[0];
		queue.markFailed([row.id]);
		row = queue.drainAll()[0];
		expect(row.retry_count).toBe(1);

		queue.markFailed([row.id]);
		row = queue.drainAll()[0];
		expect(row.retry_count).toBe(2);

		queue.markFailed([row.id]);
		expect(queue.depth()).toBe(0);

		const poison = queue.listPoisonPile();
		expect(poison).toHaveLength(1);
		expect(poison[0].session_id).toBe("r2");
	});

	test("Phase 3: moveToPoisonPile sends a row directly to poison", () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary({ session_id: "r3", session_key: "slack:Cr3:Tr3" }), DECISION);
		const row = queue.drainAll()[0];
		queue.moveToPoisonPile([row.id], { [row.id]: "credential leak" });
		expect(queue.depth()).toBe(0);
		const poison = queue.listPoisonPile();
		expect(poison).toHaveLength(1);
		expect(poison[0].failure_reason).toBe("credential leak");
	});
});
