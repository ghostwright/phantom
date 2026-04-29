import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { EvolutionConfig } from "./config.ts";

// Queue stats bookkeeping for the Phase 2 cadence. Lives in its own module so
// `cadence.ts` stays focused on the trigger control flow (cron, demand,
// contention skip) rather than the metrics shape.

export type QueueTrigger = "cron" | "demand" | "manual";

export type QueueStatsEvent = {
	trigger: QueueTrigger;
	drainedDepth: number;
	durationMs: number;
};

export type QueueStats = {
	cron_fires_total: number;
	demand_fires_total: number;
	manual_fires_total: number;
	mutex_skips_total: number;
	batch_size_total: number;
	avg_depth_at_drain: number;
	batch_duration_ms_p50: number;
	batch_duration_ms_p95: number;
	last_durations: number[];
};

export function emptyQueueStats(): QueueStats {
	return {
		cron_fires_total: 0,
		demand_fires_total: 0,
		manual_fires_total: 0,
		mutex_skips_total: 0,
		batch_size_total: 0,
		avg_depth_at_drain: 0,
		batch_duration_ms_p50: 0,
		batch_duration_ms_p95: 0,
		last_durations: [],
	};
}

/**
 * Extend `metrics.json` with a `queue_stats` object so operators can see
 * cadence behaviour in the same dashboard as the existing evolution counters.
 * Keeps a sliding window of the last 100 durations so p50/p95 are bounded
 * memory and do not require a separate time-series store.
 */
export function recordQueueStats(config: EvolutionConfig, event: QueueStatsEvent): void {
	const metricsPath = config.paths.metrics_file;
	try {
		let metrics: Record<string, unknown> = {};
		if (existsSync(metricsPath)) {
			metrics = JSON.parse(readFileSync(metricsPath, "utf-8"));
		}
		const stats: QueueStats = { ...emptyQueueStats(), ...((metrics.queue_stats as QueueStats | undefined) ?? {}) };
		if (event.trigger === "cron") stats.cron_fires_total += 1;
		else if (event.trigger === "demand") stats.demand_fires_total += 1;
		else stats.manual_fires_total += 1;

		stats.batch_size_total += event.drainedDepth;
		const nextDurations = [...stats.last_durations, event.durationMs].slice(-100);
		stats.last_durations = nextDurations;
		stats.batch_duration_ms_p50 = percentile(nextDurations, 0.5);
		stats.batch_duration_ms_p95 = percentile(nextDurations, 0.95);

		const totalFires = stats.cron_fires_total + stats.demand_fires_total + stats.manual_fires_total;
		stats.avg_depth_at_drain = totalFires > 0 ? round2(stats.batch_size_total / totalFires) : 0;

		metrics.queue_stats = stats;
		writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[evolution] Failed to record queue stats: ${msg}`);
	}
}

export function recordMutexSkip(config: EvolutionConfig): void {
	const metricsPath = config.paths.metrics_file;
	try {
		let metrics: Record<string, unknown> = {};
		if (existsSync(metricsPath)) {
			metrics = JSON.parse(readFileSync(metricsPath, "utf-8"));
		}
		const stats: QueueStats = { ...emptyQueueStats(), ...((metrics.queue_stats as QueueStats | undefined) ?? {}) };
		stats.mutex_skips_total += 1;
		metrics.queue_stats = stats;
		writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[evolution] Failed to record mutex skip: ${msg}`);
	}
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
	return sorted[idx];
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}
