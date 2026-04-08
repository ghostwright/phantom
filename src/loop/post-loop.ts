import type { EvolutionEngine } from "../evolution/engine.ts";
import type { SessionData } from "../memory/consolidation.ts";
import type { MemorySystem } from "../memory/system.ts";
import type { Loop, LoopStatus } from "./types.ts";

export type LoopTranscript = {
	firstPrompt: string;
	firstResponse: string;
	summaries: string[];
	lastPrompt: string;
	lastResponse: string;
};

export type PostLoopDeps = {
	evolution?: EvolutionEngine;
	memory?: MemorySystem;
	/** Callback to update runtime's evolved config after evolution applies changes. */
	onEvolvedConfigUpdate?: (config: ReturnType<EvolutionEngine["getConfig"]>) => void;
};

function loopStatusToOutcome(status: LoopStatus): SessionData["outcome"] {
	switch (status) {
		case "done":
			return "success";
		case "stopped":
			return "abandoned";
		default:
			return "failure";
	}
}

const MAX_ROLLING_SUMMARIES = 10;

export function recordTranscript(
	transcripts: Map<string, LoopTranscript>,
	loopId: string,
	iteration: number,
	prompt: string,
	response: string,
	stateStatus: string | undefined,
): void {
	let transcript = transcripts.get(loopId);
	if (!transcript) {
		transcript = {
			firstPrompt: prompt,
			firstResponse: response,
			summaries: [],
			lastPrompt: prompt,
			lastResponse: response,
		};
		transcripts.set(loopId, transcript);
	} else {
		transcript.lastPrompt = prompt;
		transcript.lastResponse = response;
	}
	const summary = `Tick ${iteration}: ${stateStatus ?? "in-progress"}`;
	transcript.summaries.push(summary);
	if (transcript.summaries.length > MAX_ROLLING_SUMMARIES) transcript.summaries.shift();
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

export function synthesizeSessionData(loop: Loop, status: LoopStatus, transcript: LoopTranscript): SessionData {
	const outcome = loopStatusToOutcome(status);
	const header = `[Loop: ${loop.iterationCount} ticks, goal: ${loop.goal.slice(0, 200)}, outcome: ${outcome}]`;

	const userMessages = [
		`${header} Tick 1: ${transcript.firstPrompt.slice(0, 500)}`,
		...transcript.summaries,
		`Final tick: ${transcript.lastPrompt.slice(0, 500)}`,
	];

	const assistantMessages = [transcript.firstResponse.slice(0, 1000), transcript.lastResponse.slice(0, 1000)];

	// userId sentinel: channel-originated loops use channel ID, headless use "autonomous"
	const userId = loop.channelId ? `channel:${loop.channelId}` : "autonomous";

	return {
		sessionId: loop.id,
		sessionKey: loop.channelId && loop.conversationId ? `${loop.channelId}:${loop.conversationId}` : `loop:${loop.id}`,
		userId,
		userMessages,
		assistantMessages,
		toolsUsed: [],
		filesTracked: [],
		startedAt: loop.startedAt,
		endedAt: loop.finishedAt ?? new Date().toISOString(),
		costUsd: loop.totalCostUsd,
		outcome,
	};
}

/**
 * Run evolution and memory consolidation after a loop finishes.
 * Fire-and-forget from the runner's perspective - errors are logged,
 * never propagated to affect loop status.
 */
export async function runPostLoopPipeline(deps: PostLoopDeps, sessionData: SessionData): Promise<void> {
	const { evolution, memory, onEvolvedConfigUpdate } = deps;
	const { consolidateSessionWithLLM, consolidateSession, sessionDataToSummary } = await import(
		"../memory/consolidation.ts"
	);

	// Evolution pipeline - runs independently of memory state
	if (evolution) {
		const summary = sessionDataToSummary(sessionData);
		try {
			const result = await evolution.afterSession(summary);
			if (result.changes_applied.length > 0 && onEvolvedConfigUpdate) {
				onEvolvedConfigUpdate(evolution.getConfig());
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[loop] Post-loop evolution failed: ${msg}`);
		}
	}

	// Memory consolidation - runs independently of evolution state
	if (!memory?.isReady()) return;
	try {
		const useLLM = evolution?.usesLLMJudges() && evolution?.isWithinCostCap();
		if (useLLM && evolution) {
			const evolvedConfig = evolution.getConfig();
			const existingFacts = `${evolvedConfig.userProfile}\n${evolvedConfig.domainKnowledge}`;
			const { result, judgeCost } = await consolidateSessionWithLLM(memory, sessionData, existingFacts);
			if (judgeCost) evolution.trackExternalJudgeCost(judgeCost);
			if (result.episodesCreated > 0 || result.factsExtracted > 0) {
				console.log(
					`[loop] Consolidated (LLM): ${result.episodesCreated} episodes, ${result.factsExtracted} facts (${result.durationMs}ms)`,
				);
			}
		} else {
			const result = await consolidateSession(memory, sessionData);
			if (result.episodesCreated > 0 || result.factsExtracted > 0) {
				console.log(
					`[loop] Consolidated: ${result.episodesCreated} episodes, ${result.factsExtracted} facts (${result.durationMs}ms)`,
				);
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[loop] Post-loop memory consolidation failed: ${msg}`);
	}
}
