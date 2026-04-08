import { runConsolidationJudge } from "../evolution/judges/consolidation-judge.ts";
import type { JudgeCostEntry } from "../evolution/judges/types.ts";
import type { SessionSummary } from "../evolution/types.ts";
import { matchesCorrectionPattern, matchesPreferencePattern } from "../shared/patterns.ts";
import type { MemorySystem } from "./system.ts";
import type { ConsolidationResult, Episode, SemanticFact } from "./types.ts";

/**
 * Session-end consolidation using LLM judge with heuristic fallback.
 * The LLM judge detects implicit preferences, contradictions with
 * existing knowledge, and repeatable procedures.
 */
export async function consolidateSessionWithLLM(
	memory: MemorySystem,
	sessionData: SessionData,
	existingFacts: string,
): Promise<{ result: ConsolidationResult; judgeCost: JudgeCostEntry | null }> {
	try {
		const session = sessionDataToSummary(sessionData);
		const judgeResult = await runConsolidationJudge(session, existingFacts);

		const startTime = Date.now();
		let factsExtracted = 0;

		// Create the episode
		const episode = createEpisodeFromSession(sessionData);
		episode.importance = judgeResult.data.episode_importance;
		await memory.storeEpisode(episode);

		// Store extracted facts
		const now = new Date().toISOString();
		for (const fact of judgeResult.data.extracted_facts) {
			await memory.storeFact({
				id: crypto.randomUUID(),
				subject: fact.subject,
				predicate: fact.predicate,
				object: fact.object,
				natural_language: fact.natural_language,
				source_episode_ids: [episode.id],
				confidence: fact.confidence,
				valid_from: now,
				valid_until: null,
				version: 1,
				previous_version_id: null,
				category: fact.category,
				tags: [fact.category],
			});
			factsExtracted++;
		}

		// Store detected procedures
		for (const procedure of judgeResult.data.detected_procedures) {
			await memory.storeProcedure({
				id: crypto.randomUUID(),
				name: procedure.name,
				description: procedure.description,
				trigger: procedure.trigger,
				steps: procedure.steps.map((step, i) => ({
					order: i + 1,
					action: step,
					tool: null,
					expected_outcome: "",
					error_handling: null,
					decision_point: false,
				})),
				preconditions: [],
				postconditions: [],
				parameters: {},
				source_episode_ids: [episode.id],
				success_count: session.outcome === "success" ? 1 : 0,
				failure_count: session.outcome === "failure" ? 1 : 0,
				last_used_at: now,
				confidence: procedure.confidence,
				version: 1,
			});
		}

		return {
			result: {
				episodesCreated: 1,
				factsExtracted,
				proceduresDetected: judgeResult.data.detected_procedures.length,
				durationMs: Date.now() - startTime,
			},
			judgeCost: {
				calls: 1,
				totalUsd: judgeResult.costUsd,
				totalInputTokens: judgeResult.inputTokens,
				totalOutputTokens: judgeResult.outputTokens,
			},
		};
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);
		console.warn(`[memory] Consolidation judge failed, falling back to heuristic: ${msg}`);
		const result = await consolidateSession(memory, sessionData);
		return { result, judgeCost: null };
	}
}

function sessionDataToSummary(data: SessionData): SessionSummary {
	return {
		session_id: data.sessionId,
		session_key: data.sessionKey,
		user_id: data.userId,
		user_messages: data.userMessages,
		assistant_messages: data.assistantMessages,
		tools_used: data.toolsUsed,
		files_tracked: data.filesTracked,
		outcome: data.outcome,
		cost_usd: data.costUsd,
		started_at: data.startedAt,
		ended_at: data.endedAt,
	};
}

/**
 * Session-end consolidation: extract an episode and semantic facts
 * from a completed conversation using heuristic patterns.
 */
export async function consolidateSession(memory: MemorySystem, sessionData: SessionData): Promise<ConsolidationResult> {
	const startTime = Date.now();
	let episodesCreated = 0;
	let factsExtracted = 0;

	// Create the episode from session data
	const episode = createEpisodeFromSession(sessionData);
	await memory.storeEpisode(episode);
	episodesCreated = 1;

	// Extract facts from user messages using heuristics
	const facts = extractFactsFromSession(sessionData, episode.id);
	for (const fact of facts) {
		await memory.storeFact(fact);
		factsExtracted++;
	}

	return {
		episodesCreated,
		factsExtracted,
		proceduresDetected: 0,
		durationMs: Date.now() - startTime,
	};
}

export type SessionData = {
	sessionId: string;
	sessionKey: string;
	userId: string;
	userMessages: string[];
	assistantMessages: string[];
	toolsUsed: string[];
	filesTracked: string[];
	startedAt: string;
	endedAt: string;
	costUsd: number;
	outcome: "success" | "failure" | "partial" | "abandoned";
};

function createEpisodeFromSession(data: SessionData): Episode {
	const duration = Math.round((new Date(data.endedAt).getTime() - new Date(data.startedAt).getTime()) / 1000);

	// Build a summary from user messages
	const firstMessage = data.userMessages[0] ?? "No user message";
	const summary = firstMessage.length > 200 ? `${firstMessage.slice(0, 197)}...` : firstMessage;

	const detail = [
		`User asked: ${summary}`,
		data.toolsUsed.length > 0 ? `Tools used: ${data.toolsUsed.join(", ")}` : "",
		data.filesTracked.length > 0 ? `Files modified: ${data.filesTracked.join(", ")}` : "",
		`Outcome: ${data.outcome}`,
		`Cost: $${data.costUsd.toFixed(4)}`,
	]
		.filter(Boolean)
		.join("\n");

	return {
		id: crypto.randomUUID(),
		type: "task",
		summary,
		detail,
		parent_id: null,
		session_id: data.sessionId,
		user_id: data.userId,
		tools_used: data.toolsUsed,
		files_touched: data.filesTracked,
		outcome: data.outcome,
		outcome_detail: `Session completed as ${data.outcome}`,
		lessons: [],
		started_at: data.startedAt,
		ended_at: data.endedAt,
		duration_seconds: duration,
		importance: calculateImportance(data),
		access_count: 0,
		last_accessed_at: data.endedAt,
		decay_rate: 1.0,
	};
}

function calculateImportance(data: SessionData): number {
	let importance = 0.5;

	// Errors are more important to remember
	if (data.outcome === "failure") importance += 0.2;
	if (data.outcome === "partial") importance += 0.1;

	// Sessions with more tool use are more substantive
	if (data.toolsUsed.length > 5) importance += 0.1;

	// Sessions with file modifications are more important
	if (data.filesTracked.length > 0) importance += 0.1;

	return Math.min(importance, 1.0);
}

/**
 * HEURISTIC FALLBACK: Only runs when LLM judges are unavailable.
 * Do NOT expand these patterns. If coverage is insufficient,
 * fix the LLM judge availability instead.
 *
 * Heuristic fact extraction from user messages.
 * Looks for correction patterns, preferences, and explicit facts.
 */
function extractFactsFromSession(data: SessionData, episodeId: string): SemanticFact[] {
	const facts: SemanticFact[] = [];
	const now = new Date().toISOString();

	for (const message of data.userMessages) {
		const lower = message.toLowerCase();

		// Detect corrections: "no, it should be...", "actually, ...", "not X, Y"
		if (matchesCorrectionPattern(lower)) {
			facts.push({
				id: crypto.randomUUID(),
				subject: "user_correction",
				predicate: "stated",
				object: message.slice(0, 200),
				natural_language: message.slice(0, 300),
				source_episode_ids: [episodeId],
				confidence: 0.8,
				valid_from: now,
				valid_until: null,
				version: 1,
				previous_version_id: null,
				category: "user_preference",
				tags: ["correction"],
			});
		}

		// Detect preferences: "I prefer...", "always use...", "never do..."
		if (matchesPreferencePattern(lower)) {
			facts.push({
				id: crypto.randomUUID(),
				subject: "user",
				predicate: "prefers",
				object: message.slice(0, 200),
				natural_language: message.slice(0, 300),
				source_episode_ids: [episodeId],
				confidence: 0.9,
				valid_from: now,
				valid_until: null,
				version: 1,
				previous_version_id: null,
				category: "user_preference",
				tags: ["preference"],
			});
		}
	}

	return facts;
}
