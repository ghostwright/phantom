import { existsSync, readFileSync } from "node:fs";
import { type BatchResult, processBatch } from "./batch-processor.ts";
import type { EvolutionConfig } from "./config.ts";
import type { EvolutionEngine } from "./engine.ts";
import { type QueueTrigger, recordMutexSkip, recordQueueStats } from "./queue-stats.ts";
import type { EvolutionQueue } from "./queue.ts";

// Phase 2 cadence scheduler.
//
// Two trigger paths converge on the same `drainAndProcess`:
//  1. A cron self-scheduling `setTimeout` that fires every `cadenceMinutes`.
//  2. A demand watcher that fires immediately when queue depth crosses
//     `demandTriggerDepth` so bursty sessions get processed without waiting
//     the full cadence window.
//
// The cadence must skip (not wait) on mutex contention. If Phase 0's
// `EvolutionEngine.afterSession` mutex is held when the cadence fires, the
// cadence logs a skip and the dropped rows stay in the queue for the next
// tick. Queuing dropped ticks behind a slow batch would defeat the safety
// floor that Phase 0 just added, so we bias the other way.

export type CadenceConfig = {
	cadenceMinutes: number;
	demandTriggerDepth: number;
};

export const DEFAULT_CADENCE_CONFIG: CadenceConfig = {
	cadenceMinutes: 180,
	demandTriggerDepth: 5,
};

/**
 * Runtime config override for the cadence. Operators can tune both knobs
 * without touching the YAML by dropping `phantom-config/meta/evolution.json`.
 * The file is optional; defaults apply when absent.
 */
export function loadCadenceConfig(config: EvolutionConfig): CadenceConfig {
	const path = `${configMetaDir(config)}/evolution.json`;
	if (!existsSync(path)) return DEFAULT_CADENCE_CONFIG;
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!raw || typeof raw !== "object") return DEFAULT_CADENCE_CONFIG;
		const obj = raw as Record<string, unknown>;
		const cadence =
			typeof obj.cadence_minutes === "number" ? obj.cadence_minutes : DEFAULT_CADENCE_CONFIG.cadenceMinutes;
		const depth =
			typeof obj.demand_trigger_depth === "number"
				? obj.demand_trigger_depth
				: DEFAULT_CADENCE_CONFIG.demandTriggerDepth;
		return { cadenceMinutes: cadence, demandTriggerDepth: depth };
	} catch {
		return DEFAULT_CADENCE_CONFIG;
	}
}

export class EvolutionCadence {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private stopped = false;
	private inFlight: Promise<BatchResult | null> | null = null;

	constructor(
		private readonly engine: EvolutionEngine,
		private readonly queue: EvolutionQueue,
		private readonly evolutionConfig: EvolutionConfig,
		private readonly cadenceConfig: CadenceConfig,
	) {}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.stopped = false;
		this.scheduleNextTick();
	}

	stop(): void {
		this.stopped = true;
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	getCadenceConfig(): CadenceConfig {
		return this.cadenceConfig;
	}

	/**
	 * Notify the cadence that a new row was just enqueued. If the queue depth
	 * has reached the demand trigger, fire a drain immediately. Otherwise
	 * do nothing: the cron will pick it up at the next tick.
	 */
	onEnqueue(): void {
		if (!this.running) return;
		const depth = this.queue.depth();
		if (depth >= this.cadenceConfig.demandTriggerDepth) {
			void this.drainAndProcess("demand");
		}
	}

	/**
	 * Manual/test entry point. Always attempts a drain regardless of depth.
	 * Returns the batch result or null if the drain was skipped due to
	 * mutex contention.
	 */
	async triggerNow(): Promise<BatchResult | null> {
		return this.drainAndProcess("manual");
	}

	private scheduleNextTick(): void {
		if (this.stopped) return;
		// setTimeout stores its delay in a 32-bit signed integer, so values
		// above ~24.8 days wrap and fire immediately (not once per month).
		// Cap the interval at a safe maximum and keep the minimum at 1 ms so
		// zero-length test cadences still tick once.
		const MAX_SAFE_TIMEOUT_MS = 2_147_483_000;
		const rawDelay = this.cadenceConfig.cadenceMinutes * 60_000;
		const delayMs = Math.max(1, Math.min(MAX_SAFE_TIMEOUT_MS, rawDelay));
		this.timer = setTimeout(() => {
			void this.onCronTick();
		}, delayMs);
		// Bun's setTimeout returns a Timer object; unref() is safe to call on
		// either bun or node so the cron does not keep the process alive on
		// clean shutdown paths.
		const timer = this.timer as unknown as { unref?: () => void };
		timer.unref?.();
	}

	private async onCronTick(): Promise<void> {
		try {
			await this.drainAndProcess("cron");
		} finally {
			this.scheduleNextTick();
		}
	}

	// Skip on mutex contention (never wait). If a previous batch is still
	// running when a cron or demand tick arrives, we log and return. The
	// rows stay in the queue and get picked up on the next tick. Waiting
	// would stack ticks and re-introduce the fork-bomb shape Phase 0 just
	// closed.
	private async drainAndProcess(trigger: QueueTrigger): Promise<BatchResult | null> {
		if (this.inFlight) {
			console.log(`[evolution] previous batch still in flight, skipping this tick (trigger=${trigger})`);
			recordMutexSkip(this.evolutionConfig);
			return null;
		}

		const work = this.runDrain(trigger);
		this.inFlight = work;
		try {
			return await work;
		} finally {
			this.inFlight = null;
		}
	}

	private async runDrain(trigger: QueueTrigger): Promise<BatchResult | null> {
		const queued = this.queue.drainAll();
		if (queued.length === 0) {
			return null;
		}
		console.log(
			`[evolution] draining batch of ${queued.length} sessions (trigger=${trigger}, cadence=${this.cadenceConfig.cadenceMinutes}min)`,
		);
		const result = await processBatch(queued, this.engine);

		// Phase 3 queue disposition (switch on the explicit enum carried by
		// every batch entry):
		//  - ok / skip:         delete from queue via markProcessed.
		//  - invariant_failed:  increment retry_count via markFailed; graduates
		//                       to the poison pile at count >= 3.
		//  - transient:         leave in place so the next drain retries them
		//                       without a retry_count bump.
		const okIds: number[] = [];
		const failedIds: number[] = [];
		const failedReasons: Record<number, string> = {};
		for (const entry of result.results) {
			switch (entry.disposition) {
				case "ok":
				case "skip":
					okIds.push(entry.id);
					break;
				case "invariant_failed":
					failedIds.push(entry.id);
					failedReasons[entry.id] = entry.error ?? "invariant hard fail";
					break;
				case "transient":
					console.warn(
						`[evolution] queue row id=${entry.id} transient failure, leaving in queue: ${entry.error ?? "unknown"}`,
					);
					break;
			}
		}
		this.queue.markProcessed(okIds);
		if (failedIds.length > 0) {
			const disposition = this.queue.markFailed(failedIds, failedReasons);
			if (disposition.poisoned.length > 0) {
				console.warn(`[evolution] rows poisoned after retry ceiling: ${disposition.poisoned.join(",")}`);
			}
			if (disposition.retried.length > 0) {
				console.warn(`[evolution] rows left in queue with incremented retry_count: ${disposition.retried.join(",")}`);
			}
		}

		const appliedCount = result.results.reduce((sum, r) => {
			if (r.disposition === "ok" && r.result) return sum + r.result.changes.length;
			return sum;
		}, 0);
		console.log(
			`[evolution] batch complete: ${result.processed} processed, ${appliedCount} applied changes, duration=${result.durationMs}ms`,
		);

		recordQueueStats(this.evolutionConfig, {
			trigger,
			drainedDepth: queued.length,
			durationMs: result.durationMs,
		});

		return result;
	}
}

function configMetaDir(config: EvolutionConfig): string {
	// metrics_file lives at `<config_dir>/meta/metrics.json` by default, so
	// the meta directory is its parent. Pulling it from the path avoids a
	// second string in the EvolutionConfig schema for the same thing.
	const metricsPath = config.paths.metrics_file;
	const idx = metricsPath.lastIndexOf("/");
	return idx === -1 ? "." : metricsPath.slice(0, idx);
}
