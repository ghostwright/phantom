import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { processBatch } from "../batch-processor.ts";
import type { EvolutionEngine } from "../engine.ts";
import type { GateDecision } from "../gate-types.ts";
import { EvolutionQueue, type QueuedSession } from "../queue.ts";
import type { ReflectionSubprocessResult, SessionSummary } from "../types.ts";

// Phase 3 batch processor tests. Focused on the rewrite: one subprocess
// call per batch, mapping invariant hard fails to disposition:"invariant_failed"
// entries, transient crashes to disposition:"transient" entries, and clean
// ok/skip to disposition:"ok"/"skip" entries the cadence can markProcessed.

function newDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	for (const stmt of MIGRATIONS) db.run(stmt);
	return db;
}

function makeSummary(id: string): SessionSummary {
	return {
		session_id: id,
		session_key: `slack:C:${id}`,
		user_id: "u1",
		user_messages: ["hi"],
		assistant_messages: ["ok"],
		tools_used: [],
		files_tracked: [],
		outcome: "success",
		cost_usd: 0.01,
		started_at: "2026-04-14T10:00:00Z",
		ended_at: "2026-04-14T10:01:00Z",
	};
}

const DECISION: GateDecision = {
	fire: true,
	source: "haiku",
	reason: "r",
	haiku_cost_usd: 0,
};

function baseResult(overrides: Partial<ReflectionSubprocessResult> = {}): ReflectionSubprocessResult {
	return {
		drainId: "d1",
		status: "ok",
		tier: "haiku",
		escalatedFromTier: null,
		version: 1,
		changes: [],
		invariantHardFailures: [],
		invariantSoftWarnings: [],
		costUsd: 0.001,
		durationMs: 5,
		error: null,
		incrementRetryOnFailure: false,
		statsDelta: { drains: 1 },
		...overrides,
	};
}

function fakeEngine(run: (batch: QueuedSession[]) => Promise<ReflectionSubprocessResult>): EvolutionEngine {
	return { runDrainPipeline: run } as unknown as EvolutionEngine;
}

describe("processBatch", () => {
	let db: Database;
	beforeEach(() => {
		db = newDb();
	});
	afterEach(() => {
		db.close();
	});

	test("empty batch returns zeroes without calling the engine", async () => {
		let called = 0;
		const engine = fakeEngine(async () => {
			called += 1;
			return baseResult();
		});
		const result = await processBatch([], engine);
		expect(result.processed).toBe(0);
		expect(result.successCount).toBe(0);
		expect(result.failureCount).toBe(0);
		expect(called).toBe(0);
	});

	test("successful drain marks every row ok", async () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary("a"), DECISION);
		queue.enqueue(makeSummary("b"), DECISION);
		const engine = fakeEngine(async () => baseResult());
		const result = await processBatch(queue.drainAll(), engine);
		expect(result.successCount).toBe(2);
		expect(result.failureCount).toBe(0);
		for (const entry of result.results) expect(entry.disposition).toBe("ok");
	});

	test("skip status flows through as disposition:skip", async () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary("a"), DECISION);
		const engine = fakeEngine(async () => baseResult({ status: "skip" }));
		const result = await processBatch(queue.drainAll(), engine);
		expect(result.successCount).toBe(1);
		for (const entry of result.results) expect(entry.disposition).toBe("skip");
	});

	test("invariant hard fail marks every row disposition:invariant_failed", async () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary("a"), DECISION);
		queue.enqueue(makeSummary("b"), DECISION);
		const engine = fakeEngine(async () =>
			baseResult({
				status: "skip",
				invariantHardFailures: [{ check: "I1", message: "scope" }],
				incrementRetryOnFailure: true,
				error: "I1",
			}),
		);
		const result = await processBatch(queue.drainAll(), engine);
		expect(result.failureCount).toBe(2);
		for (const entry of result.results) {
			expect(entry.disposition).toBe("invariant_failed");
			expect(entry.error).toContain("I1");
		}
	});

	test("subprocess error without invariant fail is reported as disposition:transient", async () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary("a"), DECISION);
		const engine = fakeEngine(async () => baseResult({ error: "killed", status: "skip" }));
		const result = await processBatch(queue.drainAll(), engine);
		expect(result.failureCount).toBe(1);
		for (const entry of result.results) {
			expect(entry.disposition).toBe("transient");
			expect(entry.error).toBe("killed");
		}
	});

	test("runDrainPipeline throwing is captured as disposition:transient on every row", async () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary("a"), DECISION);
		queue.enqueue(makeSummary("b"), DECISION);
		queue.enqueue(makeSummary("c"), DECISION);
		const engine = fakeEngine(async () => {
			throw new Error("runtime blew up");
		});
		const result = await processBatch(queue.drainAll(), engine);
		expect(result.failureCount).toBe(3);
		for (const entry of result.results) {
			expect(entry.disposition).toBe("transient");
			expect(entry.error).toContain("runtime blew up");
		}
	});

	test("the engine receives the full batch in a single call", async () => {
		const queue = new EvolutionQueue(db);
		queue.enqueue(makeSummary("a"), DECISION);
		queue.enqueue(makeSummary("b"), DECISION);
		queue.enqueue(makeSummary("c"), DECISION);
		let sizeSeen = -1;
		const engine = fakeEngine(async (batch) => {
			sizeSeen = batch.length;
			return baseResult();
		});
		await processBatch(queue.drainAll(), engine);
		expect(sizeSeen).toBe(3);
	});
});
