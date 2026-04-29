import { describe, expect, test } from "bun:test";
import type {
	EvolutionLogEntry,
	EvolutionResult,
	EvolutionVersion,
	InvariantCode,
	ReflectionStats,
	ReflectionSubprocessResult,
	ReflectionTier,
	SubprocessSentinel,
	SubprocessStatus,
	VersionChange,
} from "../types.ts";

// Pin the Phase 3 type surface so a future refactor cannot silently drop
// a load-bearing field. These tests are compile-time + structural: they
// exist so a deletion of any of these fields makes tsc fail here first.

describe("Phase 3 evolution types are structurally consistent", () => {
	test("VersionChange.type is one of the four allowed shapes", () => {
		const edit: VersionChange = { file: "a", type: "edit", summary: "s", rationale: "r", session_ids: ["s"] };
		const compact: VersionChange = { ...edit, type: "compact" };
		const newFile: VersionChange = { ...edit, type: "new" };
		const deleted: VersionChange = { ...edit, type: "delete" };
		expect([edit, compact, newFile, deleted]).toHaveLength(4);
	});

	test("EvolutionVersion carries the parent/version chain", () => {
		const v: EvolutionVersion = {
			version: 1,
			parent: 0,
			timestamp: "t",
			changes: [],
			metrics_at_change: { session_count: 0, success_rate_7d: 0 },
		};
		expect(v.version).toBe(1);
		expect(v.parent).toBe(0);
	});

	test("EvolutionResult includes the applied and rejected arrays", () => {
		const r: EvolutionResult = {
			version: 2,
			changes_applied: [],
			changes_rejected: [],
		};
		expect(r.changes_applied).toHaveLength(0);
		expect(r.changes_rejected).toHaveLength(0);
	});

	test("EvolutionLogEntry carries the drain_id and tier", () => {
		const entry: EvolutionLogEntry = {
			timestamp: "t",
			version: 1,
			drain_id: "batch-abc",
			session_ids: ["s1"],
			tier: "haiku",
			status: "ok",
			changes_applied: 1,
			details: [],
		};
		expect(entry.drain_id).toBe("batch-abc");
		expect(entry.tier).toBe("haiku");
	});

	test("SubprocessSentinel allows the three top-level status shapes", () => {
		// Compaction is a per-change annotation (action:"compact"), not a
		// top-level status. The status union is ok | skip | escalate.
		const ok: SubprocessSentinel = { status: "ok", changes: [{ file: "a.md", action: "edit", summary: "x" }] };
		const okCompact: SubprocessSentinel = {
			status: "ok",
			changes: [{ file: "a.md", action: "compact", expected_shrinkage: 0.5 }],
		};
		const skip: SubprocessSentinel = { status: "skip", reason: "nothing to learn" };
		const escalate: SubprocessSentinel = { status: "escalate", target: "sonnet", reason: "too hard" };
		expect([ok, okCompact, skip, escalate]).toHaveLength(4);
	});

	test("ReflectionSubprocessResult carries the incrementRetryOnFailure flag", () => {
		const r: ReflectionSubprocessResult = {
			drainId: "d",
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
			statsDelta: {},
		};
		expect(r.incrementRetryOnFailure).toBe(false);
	});

	test("ReflectionStats carries all tier and escalation counters", () => {
		const keys: Array<keyof ReflectionStats> = [
			"drains",
			"stage_haiku_runs",
			"stage_sonnet_runs",
			"stage_opus_runs",
			"escalation_haiku_to_sonnet",
			"escalation_sonnet_to_opus",
			"escalation_cap_hit",
			"status_ok",
			"status_skip",
			"sigkill_before_write",
			"sigkill_mid_write",
			"timeout_haiku",
			"timeout_sonnet",
			"timeout_opus",
			"invariant_failed_hard",
			"invariant_warned_soft",
			"sentinel_parse_fail",
			"total_cost_usd",
			"compactions_performed",
			"files_touched",
		];
		// If any key disappears from the type this line fails compilation.
		expect(keys.length).toBeGreaterThan(15);
	});

	test("InvariantCode includes all nine invariants", () => {
		const codes: InvariantCode[] = ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9"];
		expect(codes).toHaveLength(9);
	});

	test("ReflectionTier and SubprocessStatus have the expected shapes", () => {
		const tiers: ReflectionTier[] = ["haiku", "sonnet", "opus"];
		const statuses: SubprocessStatus[] = ["ok", "skip", "escalate"];
		expect(tiers).toHaveLength(3);
		expect(statuses).toHaveLength(3);
	});
});
