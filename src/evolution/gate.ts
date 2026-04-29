import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JudgeSubprocessError } from "../agent/judge-query.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { EvolutionConfig } from "./config.ts";
import { GateJudgeResult, type GateJudgeResultType, gateJudgePrompt } from "./gate-prompt.ts";
import type { GateDecision } from "./gate-types.ts";
import { JUDGE_MODEL_HAIKU } from "./judge-models.ts";
import type { SessionSummary } from "./types.ts";

// Phase 1 conditional firing gate.
//
// Cardinal Rule compliance: TypeScript serialises session metadata into a
// compact summary and asks Haiku. Haiku decides whether the session shows
// durable learning signal. No regex pre-filter, no hardcoded skip conditions,
// no `classifyUserIntent` spelled in rules. The agent understands context;
// TypeScript does not.
//
// Failsafe: any error from the Haiku subprocess (timeout, parse failure,
// subprocess SIGKILL, unparseable JSON) returns `fire: true` so transient
// failures never silently drop learning signal. Over-firing is bounded by the
// Phase 0 daily cost cap and by the Phase 2 cadence batching.

const GATE_LOG_FILENAME = "evolution-gate-log.jsonl";

export type GateStats = {
	total_decisions: number;
	fired_by_haiku: number;
	skipped_by_haiku: number;
	fired_by_failsafe: number;
	haiku_cost_usd_total: number;
};

export function emptyGateStats(): GateStats {
	return {
		total_decisions: 0,
		fired_by_haiku: 0,
		skipped_by_haiku: 0,
		fired_by_failsafe: 0,
		haiku_cost_usd_total: 0,
	};
}

/**
 * Main entry point for Phase 1. Builds a compact session summary, sends it
 * to Haiku via `runJudgeQuery`, and returns the decision. On any error, the
 * failsafe defaults to `fire: true`.
 *
 * The runtime argument is optional so heuristic-only deployments that have
 * no Agent SDK credentials still get a meaningful decision (they hit the
 * failsafe path unconditionally, which is the correct bias).
 */
export async function decideGate(session: SessionSummary, runtime: AgentRuntime | null): Promise<GateDecision> {
	if (!runtime) {
		return {
			fire: true,
			source: "failsafe",
			reason: "no runtime available for Haiku gate, defaulting to fire",
			haiku_cost_usd: 0,
		};
	}

	const firstUser = truncate(session.user_messages[0] ?? "", 240);
	const lastUser = truncate(session.user_messages[session.user_messages.length - 1] ?? "", 240);
	const lastAgent = truncate(session.assistant_messages[session.assistant_messages.length - 1] ?? "", 400);
	const durationSeconds = Math.max(
		0,
		Math.round((Date.parse(session.ended_at) - Date.parse(session.started_at)) / 1000),
	);

	const prompt = gateJudgePrompt({
		channelType: inferChannelType(session.session_key),
		turnCount: session.user_messages.length,
		durationSeconds,
		totalCostUsd: session.cost_usd ?? 0,
		toolsUsed: (session.tools_used ?? []).join(",") || "(none)",
		outcome: session.outcome,
		firstUserMessage: firstUser || "(none)",
		lastUserMessage: lastUser || "(none)",
		lastAgentMessage: lastAgent || "(none)",
		// The SessionSummary shape does not yet carry reactions or hook block
		// counts, so these are always zero until Phase 3 extends it. Haiku
		// still gets a consistent schema shape which we can enrich later
		// without changing the prompt contract.
		userReactions: "(none)",
		hookBlockCount: 0,
		toolErrorCount: countToolErrors(session),
	});

	try {
		const result = await runtime.judgeQuery<GateJudgeResultType>({
			systemPrompt: prompt.system,
			userMessage: prompt.user,
			schema: GateJudgeResult,
			model: JUDGE_MODEL_HAIKU,
			maxTokens: 200,
			// The gate is a pure pass/skip evaluation. It never reads files,
			// runs commands, or calls tools. Skipping the `claude_code` preset
			// drops the per-call input token count from thousands to a few
			// hundred, which is what the research cost target assumed and what
			// observed fleet spend (20-180x target) exposed as broken.
			omitPreset: true,
		});
		const evolve = result.data.evolve === true;
		return {
			fire: evolve,
			source: "haiku",
			reason: result.data.reason || (evolve ? "haiku voted to evolve" : "haiku voted to skip"),
			haiku_cost_usd: result.costUsd,
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		// Phase 0 partial cost capture applies here: a SIGKILLed Haiku
		// subprocess still burned tokens we want to see in the gate stats.
		const haikuCost = err instanceof JudgeSubprocessError ? err.partialCost.costUsd : 0;
		console.warn(
			`[evolution] gate error for session ${session.session_id}: ${msg} (defaulting to fire=true as failsafe)`,
		);
		return {
			fire: true,
			source: "failsafe",
			reason: `gate error: ${msg}`,
			haiku_cost_usd: haikuCost,
		};
	}
}

/**
 * Append one line per decision to `evolution-gate-log.jsonl`. Matches the
 * append pattern used by `application.ts` for `evolution-log.jsonl`.
 */
export function appendGateLog(config: EvolutionConfig, session: SessionSummary, decision: GateDecision): void {
	const logPath = join(dirname(config.paths.metrics_file), GATE_LOG_FILENAME);
	try {
		const dir = dirname(logPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const line = {
			ts: new Date().toISOString(),
			session_id: session.session_id,
			session_key: session.session_key,
			fire: decision.fire,
			source: decision.source,
			reason: decision.reason,
			haiku_cost_usd: decision.haiku_cost_usd,
		};
		appendFileSync(logPath, `${JSON.stringify(line)}\n`, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[evolution] Failed to write gate log: ${msg}`);
	}
}

/**
 * Increment the `gate_stats` object on `metrics.json`. Matches the style of
 * `recordJudgeCosts` in `engine.ts`: read, merge, write.
 */
export function recordGateDecision(config: EvolutionConfig, decision: GateDecision): void {
	const metricsPath = config.paths.metrics_file;
	try {
		let metrics: Record<string, unknown> = {};
		if (existsSync(metricsPath)) {
			metrics = JSON.parse(readFileSync(metricsPath, "utf-8"));
		}
		const stats: GateStats = {
			...emptyGateStats(),
			...((metrics.gate_stats as GateStats | undefined) ?? {}),
		};
		stats.total_decisions += 1;
		if (decision.fire) {
			if (decision.source === "haiku") stats.fired_by_haiku += 1;
			else stats.fired_by_failsafe += 1;
		} else {
			stats.skipped_by_haiku += 1;
		}
		stats.haiku_cost_usd_total += decision.haiku_cost_usd;
		metrics.gate_stats = stats;
		writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[evolution] Failed to record gate stats: ${msg}`);
	}
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}...`;
}

function inferChannelType(sessionKey: string): string {
	const prefix = sessionKey.split(":")[0];
	return prefix || "cli";
}

function countToolErrors(session: SessionSummary): number {
	let count = 0;
	for (const msg of session.assistant_messages) {
		if (msg.includes("Error:")) count += 1;
	}
	return count;
}
