import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "../agent/runtime.ts";
import { type EvolutionConfig, loadEvolutionConfig } from "./config.ts";
import type { GateDecision } from "./gate-types.ts";
import { appendGateLog, decideGate, recordGateDecision } from "./gate.ts";
import {
	getMetricsSnapshot,
	readMetrics,
	recordReflectionRun,
	updateAfterEvolution,
	updateAfterSession,
} from "./metrics.ts";
import type { EvolutionQueue } from "./queue.ts";
import { runReflectionSubprocess } from "./reflection-subprocess.ts";
import type {
	EvolutionLogEntry,
	EvolutionResult,
	EvolvedConfig,
	ReflectionSubprocessResult,
	SessionSummary,
} from "./types.ts";
import { getEvolutionLog, readVersion } from "./versioning.ts";

// Phase 3 evolution engine.
//
// The 6-judge `runCycle` pipeline is deleted. `afterSession` is now a thin
// mutex-guarded wrapper that delegates to the reflection subprocess via the
// batch processor (production path) or a direct inline call (unit tests).
// The mutex stays as Phase 0 belt-and-suspenders: it has no cost on the
// happy path and protects against a future caller reaching
// `afterSessionInternal` outside the cadence.

export type EnqueueResult = {
	enqueued: boolean;
	decision: GateDecision;
	inlineResult?: EvolutionResult;
};

export class EvolutionEngine {
	private config: EvolutionConfig;
	private reflectionEnabled: boolean;
	private runtime: AgentRuntime | null;

	// Phase 0 belt-and-suspenders mutex. The Phase 2 cadence serialises
	// drains through its own `inFlight` guard so this is redundant on the
	// production path, but it remains load-bearing for the direct-call
	// `afterSession` unit tests and for a future caller that might reach
	// `afterSessionInternal` outside the cadence.
	private activeCycle: Promise<EvolutionResult> | null = null;
	private activeCycleSessionId: string | null = null;
	private activeCycleSkipCount = 0;

	// Dedup set so the C2 retry of a failed row does not double-count
	// session_count. Process restart clears this; a row pending retry
	// across a restart double-counts on its first post-restart drain.
	// Acceptable blip.
	private countedSessionKeys = new Set<string>();

	private queue: EvolutionQueue | null = null;
	private onEnqueue: (() => void) | null = null;
	private onConfigApplied: (() => void) | null = null;

	constructor(configPath?: string, runtime?: AgentRuntime) {
		this.config = loadEvolutionConfig(configPath);
		// Constitution presence is a hard precondition. The reflection
		// subprocess never writes constitution.md (sandbox deny + invariant
		// I2 byte compare), but the engine still expects the file to exist
		// so the subprocess can read it as identity context. Fail loud at
		// boot rather than at first drain.
		if (!existsSync(this.config.paths.constitution)) {
			throw new Error(
				`Constitution file not found at ${this.config.paths.constitution}. The constitution is required for the evolution engine to function.`,
			);
		}
		this.runtime = runtime ?? null;
		this.reflectionEnabled = this.resolveReflectionMode();
		if (this.reflectionEnabled) {
			console.log("[evolution] reflection subprocess enabled");
		} else {
			console.log("[evolution] reflection subprocess disabled (config override or no auth detected)");
		}
	}

	setRuntime(runtime: AgentRuntime): void {
		this.runtime = runtime;
	}

	setQueueWiring(queue: EvolutionQueue, onEnqueue: () => void): void {
		this.queue = queue;
		this.onEnqueue = onEnqueue;
	}

	setOnConfigApplied(callback: () => void): void {
		this.onConfigApplied = callback;
	}

	private resolveReflectionMode(): boolean {
		const setting = this.config.reflection?.enabled ?? "auto";
		if (setting === "never") return false;
		if (setting === "always") return true;

		if (this.runtime) {
			const provider = this.runtime.getPhantomConfig().provider;
			if (provider.type !== "anthropic") return true;
			if (provider.base_url) return true;
		}
		if (process.env.ANTHROPIC_API_KEY) return true;
		const home = process.env.HOME ?? homedir();
		if (existsSync(join(home, ".claude", ".credentials.json"))) return true;
		return false;
	}

	usesLLMJudges(): boolean {
		return this.reflectionEnabled;
	}

	getEvolutionConfig(): EvolutionConfig {
		return this.config;
	}

	private skippedResult(): EvolutionResult {
		return { version: this.getCurrentVersion(), changes_applied: [], changes_rejected: [] };
	}

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

		// Fallback path: no queue wired. Unit tests that construct a bare
		// EvolutionEngine exercise this. Run the pipeline inline.
		const result = await this.afterSessionInternal(session);
		return { enqueued: false, decision, inlineResult: result };
	}

	/**
	 * Phase 2 batch entry point. Called once per queued batch by
	 * `batch-processor.ts` inside the Phase 0 mutex. Signature takes the
	 * full batch (not a single session) because the reflection subprocess
	 * operates on whole drains.
	 *
	 * The engine updates session metrics here rather than inside the
	 * subprocess because `session_count` must increment exactly once per
	 * unique `session_key` regardless of whether the subprocess wrote
	 * anything. The dedup set guards against the C2 retry double-count.
	 */
	async runDrainPipeline(batch: import("./queue.ts").QueuedSession[]): Promise<ReflectionSubprocessResult> {
		for (const q of batch) {
			const session = q.session_summary;
			if (this.countedSessionKeys.has(session.session_key)) continue;
			this.countedSessionKeys.add(session.session_key);
			updateAfterSession(this.config, session.outcome);
		}

		// Disabled-mode short-circuit. With reflection.enabled:"never" or auto
		// + no credentials, the engine MUST NOT spawn the SDK subprocess. We
		// still record a synthetic skip in reflection_stats so operators can
		// see drain activity in metrics, and we still return a clean ok-style
		// result so the cadence drains the queue rather than wedging on a
		// transient-failure loop.
		if (!this.reflectionEnabled) {
			const result = this.disabledDrainResult();
			recordReflectionRun(this.config, result.statsDelta);
			this.logDrainSummary(result);
			return result;
		}

		const result = await runReflectionSubprocess({
			batch,
			config: this.config,
			phantomConfig: this.runtime ? this.runtime.getPhantomConfig() : null,
		});

		recordReflectionRun(this.config, result.statsDelta);

		if (result.status === "ok" && result.changes.length > 0) {
			updateAfterEvolution(this.config);
			this.notifyConfigApplied();
		}

		this.logDrainSummary(result);
		return result;
	}

	/**
	 * Build a synthetic ReflectionSubprocessResult for the disabled-mode
	 * short-circuit. The shape is the cleanest possible "drain consumed,
	 * nothing happened" so the batch processor maps it to disposition:"skip"
	 * and the cadence deletes the queue rows via markProcessed.
	 */
	private disabledDrainResult(): ReflectionSubprocessResult {
		return {
			drainId: `disabled-${Date.now().toString(36)}`,
			status: "skip",
			tier: "haiku",
			escalatedFromTier: null,
			version: this.getCurrentVersion(),
			changes: [],
			invariantHardFailures: [],
			invariantSoftWarnings: [],
			costUsd: 0,
			durationMs: 0,
			error: null,
			incrementRetryOnFailure: false,
			statsDelta: { drains: 1, status_skip: 1 },
		};
	}

	/**
	 * Direct-call entry point kept for the unit test path. Wraps a single
	 * session as a batch of one and runs the reflection subprocess behind
	 * the Phase 0 mutex. Also bridges into the existing `EvolutionResult`
	 * shape so legacy tests see the expected return type.
	 */
	async afterSession(session: SessionSummary): Promise<EvolutionResult> {
		return this.afterSessionInternal(session);
	}

	private async afterSessionInternal(session: SessionSummary): Promise<EvolutionResult> {
		if (this.activeCycle !== null) {
			this.activeCycleSkipCount += 1;
			const activeId = this.activeCycleSessionId ?? "unknown";
			console.log(
				`[evolution] cycle already in progress (active=${activeId}, skips=${this.activeCycleSkipCount}), ` +
					`skipping session ${session.session_id} (session_key=${session.session_key})`,
			);
			return this.skippedResult();
		}

		const cyclePromise = this.runSingleSession(session);
		this.activeCycle = cyclePromise;
		this.activeCycleSessionId = session.session_id;
		this.activeCycleSkipCount = 0;
		try {
			return await cyclePromise;
		} finally {
			this.activeCycle = null;
			this.activeCycleSessionId = null;
			this.activeCycleSkipCount = 0;
		}
	}

	private async runSingleSession(session: SessionSummary): Promise<EvolutionResult> {
		if (!this.countedSessionKeys.has(session.session_key)) {
			this.countedSessionKeys.add(session.session_key);
			updateAfterSession(this.config, session.outcome);
		}

		// Disabled-mode short-circuit on the direct-call path too. Same
		// invariants as runDrainPipeline: still record stats, still return a
		// clean skip, never spawn the SDK.
		if (!this.reflectionEnabled) {
			const result = this.disabledDrainResult();
			recordReflectionRun(this.config, result.statsDelta);
			this.logDrainSummary(result);
			return {
				version: this.getCurrentVersion(),
				changes_applied: [],
				changes_rejected: [],
			};
		}

		const queued: import("./queue.ts").QueuedSession = {
			id: 0,
			session_id: session.session_id,
			session_key: session.session_key,
			gate_decision: { fire: true, source: "failsafe", reason: "direct-call path", haiku_cost_usd: 0 },
			session_summary: session,
			enqueued_at: new Date().toISOString(),
			retry_count: 0,
		};

		const result = await runReflectionSubprocess({
			batch: [queued],
			config: this.config,
			phantomConfig: this.runtime ? this.runtime.getPhantomConfig() : null,
		});

		recordReflectionRun(this.config, result.statsDelta);

		if (result.status === "ok" && result.changes.length > 0) {
			updateAfterEvolution(this.config);
			this.notifyConfigApplied();
		}

		this.logDrainSummary(result);

		return {
			version: this.getCurrentVersion(),
			changes_applied: result.changes,
			changes_rejected: result.invariantHardFailures.map((f) => ({
				change: {
					file: f.file ?? "(multi)",
					type: "edit" as const,
					summary: f.message,
					rationale: `invariant ${f.check} failed`,
					session_ids: [session.session_id],
				},
				reasons: [`${f.check}: ${f.message}`],
			})),
		};
	}

	private logDrainSummary(result: ReflectionSubprocessResult): void {
		if (result.status === "ok" && result.changes.length > 0) {
			console.log(
				`[evolution] Applied ${result.changes.length} changes (v${result.version}) via ${result.tier}` +
					` in ${result.durationMs}ms cost=$${result.costUsd.toFixed(4)}`,
			);
		} else if (result.status === "skip") {
			console.log(`[evolution] drain ${result.drainId} skipped by subprocess`);
		} else if (result.invariantHardFailures.length > 0) {
			const summary = result.invariantHardFailures.map((f) => f.check).join(",");
			console.warn(`[evolution] drain ${result.drainId} invariant fail: ${summary}`);
		} else if (result.error) {
			console.warn(`[evolution] drain ${result.drainId} ${result.status}: ${result.error}`);
		}
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

	getEvolutionLog(limit = 50): EvolutionLogEntry[] {
		return getEvolutionLog(this.config, limit);
	}

	getMetrics() {
		return readMetrics(this.config);
	}

	private notifyConfigApplied(): void {
		if (!this.onConfigApplied) return;
		try {
			this.onConfigApplied();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[evolution] onConfigApplied callback threw: ${msg}`);
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
