import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyApproved } from "./application.ts";
import { type EvolutionConfig, loadEvolutionConfig } from "./config.ts";
import { recordObservations, runConsolidation } from "./consolidation.ts";
import { ConstitutionChecker } from "./constitution.ts";
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
import {
	buildCritiqueFromObservations,
	extractObservations,
	extractObservationsWithLLM,
	generateDeltas,
} from "./reflection.ts";
import type { EvolutionResult, EvolutionVersion, EvolvedConfig, GoldenCase, SessionSummary } from "./types.ts";
import { validateAll, validateAllWithJudges } from "./validation.ts";
import { getHistory, readVersion, rollback as versionRollback } from "./versioning.ts";

export class EvolutionEngine {
	private config: EvolutionConfig;
	private checker: ConstitutionChecker;
	private llmJudgesEnabled: boolean;
	private dailyCostUsd = 0;
	private dailyCostResetDate = "";

	constructor(configPath?: string) {
		this.config = loadEvolutionConfig(configPath);
		this.checker = new ConstitutionChecker(this.config);
		this.llmJudgesEnabled = this.resolveJudgeMode();
		if (this.llmJudgesEnabled) {
			console.log("[evolution] LLM judges enabled (API key detected)");
		} else {
			console.log("[evolution] LLM judges disabled (no API key or config override)");
		}
	}

	private resolveJudgeMode(): boolean {
		const setting = this.config.judges?.enabled ?? "auto";
		if (setting === "never") return false;
		if (setting === "always") return true;
		return !!process.env.ANTHROPIC_API_KEY;
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
	 * Main entry point: run the full 6-step evolution pipeline after a session.
	 * When useLLMJudges is true, uses Sonnet-powered judges for observation
	 * extraction, safety gate, constitution gate, regression gate, and quality
	 * assessment. Falls back to heuristics on LLM failure.
	 */
	async afterSession(session: SessionSummary): Promise<EvolutionResult> {
		const startTime = Date.now();
		const judgeCosts = emptyJudgeCosts();

		// Step 1: Observation Extraction (LLM or heuristic)
		let observations: import("./types.ts").SessionObservation[];
		if (this.llmJudgesEnabled && !this.isDailyCostCapReached()) {
			const currentConfig = this.getConfig();
			const result = await extractObservationsWithLLM(session, currentConfig);
			observations = result.observations;
			if (result.judgeCost) {
				addCost(judgeCosts.observation_extraction, result.judgeCost);
				this.incrementDailyCost(result.judgeCost.totalUsd);
			}
		} else {
			observations = extractObservations(session);
		}

		// Step 0: Update session metrics (after extraction so hadCorrections uses observation results)
		const hadCorrections = observations.some((o) => o.type === "correction");
		updateAfterSession(this.config, session.outcome, hadCorrections);

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

		if (this.llmJudgesEnabled && !this.isDailyCostCapReached()) {
			const judgeResult = await validateAllWithJudges(deltas, this.checker, goldenSuite, this.config, currentConfig);
			validationResults = judgeResult.results;
			mergeCosts(judgeCosts, judgeResult.judgeCosts);
			this.incrementDailyCost(totalCostFromJudgeCosts(judgeResult.judgeCosts));
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
		if (this.llmJudgesEnabled && !this.isDailyCostCapReached()) {
			try {
				const qualityResult = await runQualityJudge(session, currentConfig);
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
