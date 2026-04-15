import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "../agent/runtime.ts";
import { applyApproved } from "./application.ts";
import { type EvolutionConfig, loadEvolutionConfig } from "./config.ts";
import { recordObservations, runConsolidation } from "./consolidation.ts";
import { ConstitutionChecker } from "./constitution.ts";
import type { GateDecision } from "./gate-types.ts";
import { appendGateLog, decideGate, recordGateDecision } from "./gate.ts";
import { addCase, loadSuite, pruneSuite } from "./golden-suite.ts";
import { runQualityJudge } from "./judges/quality-judge.ts";
import { type JudgeCosts, emptyJudgeCosts } from "./judges/types.ts";
import {
	checkForAutoRollback,
	getMetricsSnapshot,
	readMetrics,
	resetConsolidationCounter,
	updateAfterEvolution,
	updateAfterRollback,
	updateAfterSession,
} from "./metrics.ts";
import type { EvolutionQueue } from "./queue.ts";
import {
	buildCritiqueFromObservations,
	extractObservations,
	extractObservationsWithLLM,
	generateDeltas,
} from "./reflection.ts";
import type { EvolutionResult, EvolutionVersion, EvolvedConfig, GoldenCase, SessionSummary } from "./types.ts";
import { CycleAborted, validateAll, validateAllWithJudges } from "./validation.ts";
import { getHistory, readVersion, rollback as versionRollback } from "./versioning.ts";

export type EnqueueResult = {
	enqueued: boolean;
	decision: GateDecision;
	inlineResult?: EvolutionResult;
};

export class EvolutionEngine {
	private config: EvolutionConfig;
	private checker: ConstitutionChecker;
	private llmJudgesEnabled: boolean;
	private dailyCostUsd = 0;
	private dailyCostResetDate = "";
	private runtime: AgentRuntime | null;

	// Phase 0 safety floor: process-wide mutex around the evolution pipeline.
	//
	// The engine is called after every agent turn and every feedback event via
	// two unawaited `.then/.catch` chains in src/index.ts. An 8-turn session
	// can fire 5+ overlapping cycles before the first one finishes, and each
	// cycle spawns dozens of judge subprocesses. In an 8 GB cgroup that is the
	// shape of the 2026-04-14 fork-bomb.
	//
	// A single promise guard is sufficient: if an evolution cycle is in flight
	// when `afterSession` is called, we log and return a skipped result. We
	// drop the session rather than queue it, because Phase 2 will replace the
	// drop-on-floor semantics with a real cadence-backed queue. Phase 0's job
	// is to keep the process alive, not to guarantee every session triggers.
	private activeCycle: Promise<EvolutionResult> | null = null;
	private activeCycleSessionId: string | null = null;
	private activeCycleSkipCount = 0;

	// Dedup set for the M1 single-count contract under the C2 retry path.
	// A row that fails mid-cycle stays in the queue and re-enters runCycle
	// under the same `session_key`; without this guard, `session_count` would
	// be incremented once per retry. Bounded by unique session_keys ever seen
	// by this engine instance (low thousands per year). Process restart clears
	// it, which means a row pending retry across a restart double-counts on
	// its first post-restart drain. Acceptable per-restart blip.
	private countedSessionKeys = new Set<string>();

	// Phase 1 + 2 wiring. The queue is optional so engine unit tests that do
	// not care about batching can still construct a bare engine.
	private queue: EvolutionQueue | null = null;
	private onEnqueue: (() => void) | null = null;
	// Fires after a cycle (including a partial-apply CycleAborted recovery)
	// applies at least one change to disk. Wired in `src/index.ts` so the
	// AgentRuntime in-memory `evolvedConfig` snapshot refreshes whenever the
	// queue drain produces new state. Without this, the queued path would
	// rewrite `phantom-config/` files but the live agent would keep using its
	// boot-time snapshot until the process restarts.
	private onConfigApplied: (() => void) | null = null;

	// `runtime` is optional so existing tests and heuristic-only deployments can
	// construct an engine without wiring a full AgentRuntime. When the engine
	// is asked to use LLM judges but has no runtime, it falls back to heuristics.
	constructor(configPath?: string, runtime?: AgentRuntime) {
		this.config = loadEvolutionConfig(configPath);
		this.checker = new ConstitutionChecker(this.config);
		this.runtime = runtime ?? null;
		this.llmJudgesEnabled = this.resolveJudgeMode();
		if (this.llmJudgesEnabled) {
			console.log("[evolution] LLM judges enabled");
		} else {
			console.log("[evolution] LLM judges disabled (config override or no auth detected)");
		}
	}

	setRuntime(runtime: AgentRuntime): void {
		this.runtime = runtime;
	}

	/**
	 * Wire the queue plumbing for Phase 2. Called from `src/index.ts` after
	 * the evolution queue and cadence have been constructed. Keeping these
	 * as setters rather than constructor args preserves the existing test
	 * shape (most engine tests do not care about the queue).
	 */
	setQueueWiring(queue: EvolutionQueue, onEnqueue: () => void): void {
		this.queue = queue;
		this.onEnqueue = onEnqueue;
	}

	/**
	 * Register a callback that fires whenever a cycle applies at least one
	 * change to disk. Wired from `src/index.ts` to refresh the AgentRuntime's
	 * in-memory evolved config snapshot. Matches the setter shape used by
	 * `setQueueWiring` so the engine still owns the lifecycle and the cadence
	 * stays ignorant of the runtime.
	 */
	setOnConfigApplied(callback: () => void): void {
		this.onConfigApplied = callback;
	}

	private resolveJudgeMode(): boolean {
		const setting = this.config.judges?.enabled ?? "auto";
		if (setting === "never") return false;
		if (setting === "always") return true;

		// auto mode: judges are available whenever any plausible credential path exists.
		// Evaluated in priority order:
		//  1. A non-anthropic provider was configured. The operator explicitly opted
		//     into a non-default backend, so assume they have credentials for it. We
		//     cannot validate the key here because it lives in an arbitrary env var.
		//  2. A custom base_url was set on the anthropic provider. Same reasoning: the
		//     operator pointed us at a specific endpoint on purpose.
		//  3. ANTHROPIC_API_KEY is set (the legacy default path, preserved verbatim).
		//  4. ~/.claude/.credentials.json exists. This is the `claude login` path the
		//     Phase 1 mcheema VM test exercised: no env key, just an OAuth credential
		//     file that the Agent SDK subprocess reads directly.
		if (this.runtime) {
			const provider = this.runtime.getPhantomConfig().provider;
			if (provider.type !== "anthropic") return true;
			if (provider.base_url) return true;
		}
		if (process.env.ANTHROPIC_API_KEY) return true;
		// Prefer $HOME so tests can sandbox the credentials lookup. Bun's os.homedir()
		// reads from getpwuid and ignores in-process mutations to HOME, so falling
		// back to homedir() only when HOME is unset keeps production behavior correct.
		const home = process.env.HOME ?? homedir();
		if (existsSync(join(home, ".claude", ".credentials.json"))) return true;
		return false;
	}

	usesLLMJudges(): boolean {
		return this.llmJudgesEnabled;
	}

	/** Memory consolidation runs outside afterSession() but still needs to respect the daily cap. */
	isWithinCostCap(): boolean {
		return !this.isDailyCostCapReached();
	}

	/** Consolidation judge costs happen outside the evolution pipeline but count toward the daily cap. */
	trackExternalJudgeCost(cost: { totalUsd: number }): void {
		this.resetDailyCostIfNewDay();
		this.dailyCostUsd += cost.totalUsd;
	}

	getEvolutionConfig(): EvolutionConfig {
		return this.config;
	}

	/**
	 * Returns a skipped-cycle result. Used when the mutex blocks a new cycle
	 * or when the cycle is aborted by the judge failure ceiling. Keeps the
	 * shape identical to a normal early return so callers do not need to
	 * special-case skipped cycles.
	 */
	private skippedResult(): EvolutionResult {
		return { version: this.getCurrentVersion(), changes_applied: [], changes_rejected: [] };
	}

	/**
	 * Phase 1 + 2 entry point. Runs the conditional firing gate on the
	 * session summary, logs the decision, records gate stats, and either
	 * drops the session (fire=false) or enqueues it for cadence processing
	 * (fire=true). Runs OUTSIDE the evolution mutex: the gate is cheap and
	 * serializing gate calls through the mutex would defeat the purpose.
	 */
	async enqueueIfWorthy(session: SessionSummary): Promise<EnqueueResult> {
		const decision = await decideGate(session, this.runtime);
		appendGateLog(this.config, session, decision);
		recordGateDecision(this.config, decision);

		if (!decision.fire) {
			return { enqueued: false, decision };
		}

		if (this.queue) {
			this.queue.enqueue(session, decision);
			this.onEnqueue?.();
			return { enqueued: true, decision };
		}

		// Fallback path: no queue wired. This is the shape unit tests exercise
		// when they construct a bare EvolutionEngine. We keep behaviour close
		// to the legacy afterSession call so existing assertions still pass.
		const result = await this.afterSessionInternal(session);
		return { enqueued: false, decision, inlineResult: result };
	}

	/**
	 * Phase 2 batch processor entry point. Called once per queued session by
	 * `batch-processor.ts` inside the Phase 0 mutex. Publicly exposed so the
	 * batch processor does not need to reach into private state; Phase 3 will
	 * replace the batch processor body entirely and this method becomes dead.
	 */
	async runSingleSessionPipeline(session: SessionSummary): Promise<EvolutionResult> {
		return this.afterSessionInternal(session);
	}

	/**
	 * Main entry point: run the full 6-step evolution pipeline after a session.
	 * When useLLMJudges is true, uses Sonnet-powered judges for observation
	 * extraction, safety gate, constitution gate, regression gate, and quality
	 * assessment. Falls back to heuristics on LLM failure.
	 *
	 * Phase 0 safety floor: calls that arrive while another cycle is in
	 * flight return immediately with a skipped result and no judge
	 * subprocesses spawned. Phase 2 replaced `afterSession` as the primary
	 * entry point with `enqueueIfWorthy`; direct callers still work and the
	 * mutex guard remains the same.
	 */
	async afterSession(session: SessionSummary): Promise<EvolutionResult> {
		return this.afterSessionInternal(session);
	}

	private async afterSessionInternal(session: SessionSummary): Promise<EvolutionResult> {
		// Phase 2 replaced the drop-on-floor mutex with a persistent queue, so
		// every session that crosses the gate eventually reaches `runCycle`,
		// which is the single place `session_count` is incremented (with the
		// real `hadCorrections` value after observation extraction). The Phase
		// 0 M4 increment that used to live here was load-bearing only while
		// the mutex could permanently drop a session.
		if (this.activeCycle !== null) {
			this.activeCycleSkipCount += 1;
			const activeId = this.activeCycleSessionId ?? "unknown";
			console.log(
				`[evolution] cycle already in progress (active=${activeId}, skips=${this.activeCycleSkipCount}), ` +
					`skipping session ${session.session_id} (session_key=${session.session_key})`,
			);
			return this.skippedResult();
		}

		const cyclePromise = this.runCycle(session);
		this.activeCycle = cyclePromise;
		this.activeCycleSessionId = session.session_id;
		this.activeCycleSkipCount = 0;
		try {
			return await cyclePromise;
		} finally {
			// Always clear the guard, even when the cycle threw. Without this a
			// single uncaught throw would permanently wedge the engine and no
			// further sessions would ever evolve.
			this.activeCycle = null;
			this.activeCycleSessionId = null;
			this.activeCycleSkipCount = 0;
		}
	}

	private async runCycle(session: SessionSummary): Promise<EvolutionResult> {
		const startTime = Date.now();
		const judgeCosts = emptyJudgeCosts();

		// Step 1: Observation Extraction (LLM or heuristic)
		let observations: import("./types.ts").SessionObservation[];
		if (this.llmJudgesEnabled && this.runtime && !this.isDailyCostCapReached()) {
			const currentConfig = this.getConfig();
			const result = await extractObservationsWithLLM(this.runtime, session, currentConfig);
			observations = result.observations;
			if (result.judgeCost) {
				addCost(judgeCosts.observation_extraction, result.judgeCost);
				this.incrementDailyCost(result.judgeCost.totalUsd);
			}
		} else {
			observations = extractObservations(session);
		}

		// Step 0: Update session metrics (after extraction so hadCorrections uses observation results).
		// Guarded by `countedSessionKeys` so a C2 retry of the same session_key
		// does not double-count.
		const hadCorrections = observations.some((o) => o.type === "correction");
		if (!this.countedSessionKeys.has(session.session_key)) {
			this.countedSessionKeys.add(session.session_key);
			updateAfterSession(this.config, session.outcome, hadCorrections);
		}

		if (observations.length === 0) {
			return { version: this.getCurrentVersion(), changes_applied: [], changes_rejected: [] };
		}

		// Record observations for later consolidation
		recordObservations(this.config, session.session_id, observations);

		// Step 2: Self-Critique (uses observations to build critique)
		const currentConfig = this.getConfig();
		const critique = buildCritiqueFromObservations(observations, session, currentConfig);

		// Step 3: Config Delta Generation
		const deltas = generateDeltas(critique, session.session_id);
		if (deltas.length === 0) {
			return { version: this.getCurrentVersion(), changes_applied: [], changes_rejected: [] };
		}

		// Step 4: 5-Gate Validation (LLM or heuristic)
		const goldenSuite = loadSuite(this.config);
		let validationResults: import("./types.ts").ValidationResult[];

		if (this.llmJudgesEnabled && this.runtime && !this.isDailyCostCapReached()) {
			try {
				const judgeResult = await validateAllWithJudges(
					this.runtime,
					deltas,
					this.checker,
					goldenSuite,
					this.config,
					currentConfig,
				);
				validationResults = judgeResult.results;
				mergeCosts(judgeCosts, judgeResult.judgeCosts);
				this.incrementDailyCost(totalCostFromJudgeCosts(judgeResult.judgeCosts));
			} catch (error: unknown) {
				if (error instanceof CycleAborted) {
					// Phase 0 safety floor: the failure ceiling was hit. Deltas
					// already in `partialResults` all completed the 5-gate pipeline
					// (some approved, some rejected) before the abort, so they are
					// safe to apply. Dropping them would throw away real signal on
					// every intermittent failure and stall evolution exactly when
					// the operator needs it to keep making progress.
					//
					// We apply step 5 over the partial results, log the counts, and
					// merge judge costs to metrics. Steps 6 (consolidation), 7
					// (quality judge), and 8 (auto-rollback) are skipped because
					// the environment is known unhealthy and we do not want to
					// spawn more subprocesses on top of a ceiling-triggered abort.
					console.warn(
						`[evolution] cycle aborted after ${error.failureCount} judge failures, ` +
							`dropping ${error.deltasDropped} remaining deltas (session=${session.session_id})`,
					);
					mergeCosts(judgeCosts, error.partialJudgeCosts);
					this.incrementDailyCost(totalCostFromJudgeCosts(error.partialJudgeCosts));

					const partialMetricsSnapshot = getMetricsSnapshot(this.config);
					const { applied: partialApplied, rejected: partialRejected } = applyApproved(
						error.partialResults,
						this.config,
						session.session_id,
						partialMetricsSnapshot,
					);

					if (partialApplied.length > 0) {
						updateAfterEvolution(this.config);
						console.log(
							`[evolution] Partial apply: ${partialApplied.length} changes applied ` +
								`(v${this.getCurrentVersion()}) after cycle abort`,
						);
						this.notifyConfigApplied();
					}
					if (partialRejected.length > 0) {
						console.log(`[evolution] Partial apply: ${partialRejected.length} changes rejected after cycle abort`);
					}

					if (this.llmJudgesEnabled) {
						this.recordJudgeCosts(judgeCosts);
					}

					return {
						version: this.getCurrentVersion(),
						changes_applied: partialApplied,
						changes_rejected: partialRejected.map((r) => ({ change: r.change, reasons: r.reasons })),
					};
				}
				throw error;
			}
		} else {
			validationResults = validateAll(deltas, this.checker, goldenSuite, this.config);
		}

		// Step 5: Application
		const metricsSnapshot = getMetricsSnapshot(this.config);
		const { applied, rejected } = applyApproved(validationResults, this.config, session.session_id, metricsSnapshot);

		if (applied.length > 0) {
			updateAfterEvolution(this.config);
			console.log(
				`[evolution] Applied ${applied.length} changes (v${this.getCurrentVersion()}) in ${Date.now() - startTime}ms`,
			);
			this.notifyConfigApplied();

			// Promote successful corrections to golden suite
			if (session.outcome === "success" && hadCorrections) {
				for (const change of applied) {
					const goldenCase: GoldenCase = {
						id: crypto.randomUUID(),
						description: `Correction: ${change.rationale.slice(0, 100)}`,
						lesson: change.content,
						session_id: session.session_id,
						created_at: new Date().toISOString(),
					};
					addCase(this.config, goldenCase);
				}
			}
		}

		if (rejected.length > 0) {
			console.log(`[evolution] Rejected ${rejected.length} changes`);
			for (const r of rejected) {
				console.log(`  - ${r.change.file}: ${r.reasons.join(", ")}`);
			}
		}

		// Quality Assessment (LLM only, non-blocking)
		if (this.llmJudgesEnabled && this.runtime && !this.isDailyCostCapReached()) {
			try {
				const qualityResult = await runQualityJudge(this.runtime, session, currentConfig);
				judgeCosts.quality_assessment.calls++;
				judgeCosts.quality_assessment.totalUsd += qualityResult.costUsd;
				judgeCosts.quality_assessment.totalInputTokens += qualityResult.inputTokens;
				judgeCosts.quality_assessment.totalOutputTokens += qualityResult.outputTokens;
				this.incrementDailyCost(qualityResult.costUsd);

				if (qualityResult.data.regression_signal) {
					console.warn(
						`[evolution] Quality judge detected regression signal: ${qualityResult.data.regression_reasoning ?? "no details"}`,
					);
				}
				console.log(
					`[evolution] Session quality: ${qualityResult.data.overall_score.toFixed(2)} (${qualityResult.data.goal_accomplished.verdict})`,
				);
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				console.warn(`[evolution] Quality judge failed (non-blocking): ${msg}`);
			}
		}

		// Step 6: Periodic Consolidation (if cadence reached)
		const metrics = readMetrics(this.config);
		if (metrics.sessions_since_consolidation >= this.config.cadence.consolidation_interval) {
			try {
				const report = runConsolidation(this.config);
				resetConsolidationCounter(this.config);
				console.log(
					`[evolution] Consolidation: ${report.principlesExtracted} principles, ` +
						`${report.observationsPruned} observations pruned`,
				);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[evolution] Consolidation failed: ${msg}`);
			}
		}

		// Check auto-rollback
		const rollbackCheck = checkForAutoRollback(this.config);
		if (rollbackCheck.shouldRollback) {
			console.warn(`[evolution] Auto-rollback triggered: ${rollbackCheck.reason}`);
			this.rollback(this.getCurrentVersion() - 1);
		}

		// Record judge costs to persistent metrics (daily tracking already done incrementally above)
		if (this.llmJudgesEnabled) {
			this.recordJudgeCosts(judgeCosts);
		}

		// Enforce golden suite cap
		this.pruneGoldenSuite();

		return {
			version: this.getCurrentVersion(),
			changes_applied: applied,
			changes_rejected: rejected.map((r) => ({ change: r.change, reasons: r.reasons })),
		};
	}

	getConfig(): EvolvedConfig {
		const dir = this.config.paths.config_dir;
		const version = readVersion(this.config);
		const metricsSnapshot = getMetricsSnapshot(this.config);

		return {
			constitution: readConfigFile(join(dir, "constitution.md")),
			persona: readConfigFile(join(dir, "persona.md")),
			userProfile: readConfigFile(join(dir, "user-profile.md")),
			domainKnowledge: readConfigFile(join(dir, "domain-knowledge.md")),
			strategies: {
				taskPatterns: readConfigFile(join(dir, "strategies/task-patterns.md")),
				toolPreferences: readConfigFile(join(dir, "strategies/tool-preferences.md")),
				errorRecovery: readConfigFile(join(dir, "strategies/error-recovery.md")),
			},
			meta: {
				version: version.version,
				metricsSnapshot,
			},
		};
	}

	getCurrentVersion(): number {
		return readVersion(this.config).version;
	}

	getVersionHistory(limit = 50): EvolutionVersion[] {
		return getHistory(this.config, limit);
	}

	getMetrics() {
		return readMetrics(this.config);
	}

	rollback(toVersion: number): void {
		versionRollback(this.config, toVersion);
		updateAfterRollback(this.config);
		console.log(`[evolution] Rolled back to version ${toVersion}`);
		// The auto-rollback branch in `runCycle` reverts disk state without
		// otherwise touching the runtime; without this refresh the agent keeps
		// serving the now-reverted version's snapshot until process restart.
		// `getConfig()` re-reads from disk on every call, so the callback picks
		// up the rolled-back content.
		this.notifyConfigApplied();
	}

	private resetDailyCostIfNewDay(): void {
		const today = new Date().toISOString().slice(0, 10);
		if (this.dailyCostResetDate !== today) {
			this.dailyCostUsd = 0;
			this.dailyCostResetDate = today;
		}
	}

	private isDailyCostCapReached(): boolean {
		this.resetDailyCostIfNewDay();
		const cap = this.config.judges?.cost_cap_usd_per_day ?? 50.0;
		if (this.dailyCostUsd >= cap) {
			console.warn(
				`[evolution] Daily cost cap reached ($${this.dailyCostUsd.toFixed(2)} >= $${cap}), using heuristics`,
			);
			return true;
		}
		return false;
	}

	private incrementDailyCost(usd: number): void {
		this.resetDailyCostIfNewDay();
		this.dailyCostUsd += usd;
	}

	private pruneGoldenSuite(): void {
		const maxSize = this.config.judges?.max_golden_suite_size ?? 50;
		const removed = pruneSuite(this.config, maxSize);
		if (removed > 0) {
			console.log(`[evolution] Pruned ${removed} oldest golden suite entries (cap: ${maxSize})`);
		}
	}

	private notifyConfigApplied(): void {
		if (!this.onConfigApplied) return;
		try {
			this.onConfigApplied();
		} catch (err: unknown) {
			// A telemetry/refresh failure must not wedge the evolution pipeline.
			// The next applied change will retry, and the disk-side state is
			// already correct regardless of whether the callback succeeded.
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[evolution] onConfigApplied callback threw: ${msg}`);
		}
	}

	private recordJudgeCosts(costs: JudgeCosts): void {
		const metricsPath = this.config.paths.metrics_file;
		try {
			const raw = readFileSync(metricsPath, "utf-8");
			const metrics = JSON.parse(raw);
			if (!metrics.judge_costs) {
				metrics.judge_costs = emptyJudgeCosts();
			}
			for (const key of Object.keys(costs) as Array<keyof JudgeCosts>) {
				metrics.judge_costs[key].calls += costs[key].calls;
				metrics.judge_costs[key].totalUsd += costs[key].totalUsd;
				metrics.judge_costs[key].totalInputTokens += costs[key].totalInputTokens;
				metrics.judge_costs[key].totalOutputTokens += costs[key].totalOutputTokens;
			}
			writeFileSync(metricsPath, JSON.stringify(metrics, null, 2), "utf-8");
		} catch {
			// Metrics file may not exist yet
		}
	}
}

function readConfigFile(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

function addCost(target: JudgeCosts[keyof JudgeCosts], source: JudgeCosts[keyof JudgeCosts]): void {
	target.calls += source.calls;
	target.totalUsd += source.totalUsd;
	target.totalInputTokens += source.totalInputTokens;
	target.totalOutputTokens += source.totalOutputTokens;
}

function mergeCosts(target: JudgeCosts, source: JudgeCosts): void {
	for (const key of Object.keys(source) as Array<keyof JudgeCosts>) {
		addCost(target[key], source[key]);
	}
}

function totalCostFromJudgeCosts(costs: JudgeCosts): number {
	let total = 0;
	for (const key of Object.keys(costs) as Array<keyof JudgeCosts>) {
		total += costs[key].totalUsd;
	}
	return total;
}
