import type { EvolutionEngine } from "./engine.ts";
import type { QueuedSession } from "./queue.ts";
import type { ReflectionSubprocessResult } from "./types.ts";

// Phase 3 batch processor. The Phase 2 per-session loop is gone: the
// reflection subprocess runs once per drain against the full batch. The
// signature stays compatible with cadence.ts so the downstream drain
// handling continues to work without changes.
//
// Each row carries an explicit `disposition` enum so the cadence routes
// queue rows by name rather than by an implicit `ok` boolean derived from
// an unrelated string field. The four dispositions are:
//
//   - "ok":               drain applied changes (or had nothing to write).
//                         markProcessed deletes the rows.
//   - "skip":             clean skip (subprocess returned status:"skip"
//                         with no error). markProcessed deletes the rows.
//   - "transient":        subprocess crashed, timed out, or threw. Rows
//                         stay in the queue without a retry_count bump.
//   - "invariant_failed": subprocess wrote something the invariant check
//                         rolled back. markFailed bumps retry_count and
//                         graduates rows to the poison pile at count >= 3.

export type BatchDisposition = "ok" | "skip" | "transient" | "invariant_failed";

export type SessionBatchEntry = {
	id: number;
	disposition: BatchDisposition;
	error: string | null;
	result: ReflectionSubprocessResult | null;
};

export type BatchResult = {
	processed: number;
	successCount: number;
	failureCount: number;
	results: SessionBatchEntry[];
	durationMs: number;
};

function isSuccessDisposition(disposition: BatchDisposition): boolean {
	return disposition === "ok" || disposition === "skip";
}

export async function processBatch(queuedSessions: QueuedSession[], engine: EvolutionEngine): Promise<BatchResult> {
	const startedAt = Date.now();
	if (queuedSessions.length === 0) {
		return { processed: 0, successCount: 0, failureCount: 0, results: [], durationMs: 0 };
	}

	let result: ReflectionSubprocessResult;
	try {
		result = await engine.runDrainPipeline(queuedSessions);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		const results: SessionBatchEntry[] = queuedSessions.map((q) => ({
			id: q.id,
			disposition: "transient",
			error: msg,
			result: null,
		}));
		return {
			processed: results.length,
			successCount: 0,
			failureCount: results.length,
			results,
			durationMs: Date.now() - startedAt,
		};
	}

	const disposition = classifyDrain(result);
	const success = isSuccessDisposition(disposition);
	const results: SessionBatchEntry[] = queuedSessions.map((q) => ({
		id: q.id,
		disposition,
		error: success ? null : (result.error ?? defaultErrorFor(disposition)),
		result,
	}));

	return {
		processed: results.length,
		successCount: success ? results.length : 0,
		failureCount: success ? 0 : results.length,
		results,
		durationMs: Date.now() - startedAt,
	};
}

function classifyDrain(result: ReflectionSubprocessResult): BatchDisposition {
	if (result.invariantHardFailures.length > 0 || result.incrementRetryOnFailure) {
		return "invariant_failed";
	}
	if (result.error) {
		return "transient";
	}
	if (result.status === "skip") {
		return "skip";
	}
	return "ok";
}

function defaultErrorFor(disposition: BatchDisposition): string {
	if (disposition === "invariant_failed") return "invariant hard fail";
	if (disposition === "transient") return "transient subprocess failure";
	return "unknown";
}
