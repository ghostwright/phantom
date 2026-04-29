import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { EvolutionConfig } from "./config.ts";
import type { EvolutionMetrics, MetricsSnapshot, ReflectionStats } from "./types.ts";

// Phase 3 metrics. The auto-rollback fields, consolidation counter, and
// judge_costs block are gone. A new reflection_stats block replaces judge
// costs as the operator's window into the evolution pipeline.

/**
 * Read metrics from phantom-config/meta/metrics.json. Unknown fields from
 * older installs (judge_costs, rollback_count, sessions_since_consolidation)
 * are preserved on read but new writes never emit them.
 */
export function readMetrics(config: EvolutionConfig): EvolutionMetrics {
	try {
		const text = readFileSync(config.paths.metrics_file, "utf-8");
		const parsed = JSON.parse(text) as Partial<EvolutionMetrics>;
		return { ...defaultMetrics(), ...parsed };
	} catch {
		return defaultMetrics();
	}
}

export function writeMetrics(config: EvolutionConfig, metrics: EvolutionMetrics): void {
	writeFileSync(config.paths.metrics_file, `${JSON.stringify(metrics, null, 2)}\n`, "utf-8");
}

/**
 * Update metrics after a session completes.
 */
export function updateAfterSession(
	config: EvolutionConfig,
	outcome: "success" | "failure" | "partial" | "abandoned",
): EvolutionMetrics {
	const metrics = readMetrics(config);

	metrics.session_count++;

	if (outcome === "success") {
		metrics.success_count++;
	} else if (outcome === "failure") {
		metrics.failure_count++;
	}

	metrics.last_session_at = new Date().toISOString();
	metrics.success_rate_7d = calculateRollingRate(metrics.success_count, metrics.session_count);

	writeMetrics(config, metrics);
	return metrics;
}

/**
 * Update metrics after an evolution step (reflection subprocess committed
 * at least one change to disk).
 */
export function updateAfterEvolution(config: EvolutionConfig): EvolutionMetrics {
	const metrics = readMetrics(config);
	metrics.evolution_count++;
	metrics.last_evolution_at = new Date().toISOString();
	writeMetrics(config, metrics);
	return metrics;
}

/**
 * Get a snapshot of current metrics for version tagging.
 */
export function getMetricsSnapshot(config: EvolutionConfig): MetricsSnapshot {
	const metrics = readMetrics(config);
	return {
		session_count: metrics.session_count,
		success_rate_7d: metrics.success_rate_7d,
	};
}

function defaultMetrics(): EvolutionMetrics {
	return {
		session_count: 0,
		success_count: 0,
		failure_count: 0,
		evolution_count: 0,
		last_session_at: null,
		last_evolution_at: null,
		success_rate_7d: 0,
	};
}

function calculateRollingRate(count: number, total: number): number {
	if (total === 0) return 0;
	return Math.round((count / total) * 100) / 100;
}

export function emptyReflectionStats(): ReflectionStats {
	return {
		drains: 0,
		stage_haiku_runs: 0,
		stage_sonnet_runs: 0,
		stage_opus_runs: 0,
		escalation_haiku_to_sonnet: 0,
		escalation_sonnet_to_opus: 0,
		escalation_cap_hit: 0,
		status_ok: 0,
		status_skip: 0,
		status_escalate_cap: 0,
		sigkill_before_write: 0,
		sigkill_mid_write: 0,
		timeout_haiku: 0,
		timeout_sonnet: 0,
		timeout_opus: 0,
		invariant_failed_hard: 0,
		invariant_warned_soft: 0,
		sentinel_parse_fail: 0,
		total_cost_usd: 0,
		compactions_performed: 0,
		files_touched: {},
	};
}

/**
 * Merge a per-drain reflection stats delta into the persisted metrics.json
 * `reflection_stats` block. Called by the reflection subprocess at the end
 * of every drain regardless of outcome.
 */
export function recordReflectionRun(config: EvolutionConfig, delta: Partial<ReflectionStats>): void {
	const metricsPath = config.paths.metrics_file;
	try {
		let metrics: Record<string, unknown> = {};
		if (existsSync(metricsPath)) {
			metrics = JSON.parse(readFileSync(metricsPath, "utf-8"));
		}
		const existing = (metrics.reflection_stats as ReflectionStats | undefined) ?? emptyReflectionStats();
		const merged: ReflectionStats = mergeStats(existing, delta);
		metrics.reflection_stats = merged;
		writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[evolution] Failed to record reflection stats: ${msg}`);
	}
}

function mergeStats(existing: ReflectionStats, delta: Partial<ReflectionStats>): ReflectionStats {
	const merged: ReflectionStats = { ...existing, files_touched: { ...existing.files_touched } };
	for (const [rawKey, value] of Object.entries(delta)) {
		if (value === undefined) continue;
		const key = rawKey as keyof ReflectionStats;
		if (key === "files_touched") {
			const filesDelta = value as Record<string, number>;
			for (const [file, count] of Object.entries(filesDelta)) {
				merged.files_touched[file] = (merged.files_touched[file] ?? 0) + count;
			}
			continue;
		}
		if (typeof value === "number" && typeof merged[key] === "number") {
			(merged[key] as number) = (merged[key] as number) + value;
		}
	}
	return merged;
}
