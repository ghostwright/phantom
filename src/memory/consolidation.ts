import { matchesCorrectionPattern, matchesPreferencePattern } from "../shared/patterns.ts";
import type { MemorySystem } from "./system.ts";
import type { ConsolidationResult, Episode, SemanticFact } from "./types.ts";

// Memory consolidation. Phase 3 removed the LLM consolidation-judge path
// along with the rest of the judges directory; the heuristic extractor is
// now the only consolidation path. This extractor is NOT the reflection
// subprocess: the reflection subprocess manages phantom-config memory
// files (user-profile.md, domain-knowledge.md, etc.), while this module
// manages the vector memory (Qdrant episodes and facts).

/**
 * Session-end consolidation: extract an episode and semantic facts
 * from a completed conversation using heuristic patterns.
 */
export async function consolidateSession(memory: MemorySystem, sessionData: SessionData): Promise<ConsolidationResult> {
	const startTime = Date.now();
	let episodesCreated = 0;
	let factsExtracted = 0;

	const episode = createEpisodeFromSession(sessionData);
	await memory.storeEpisode(episode);
	episodesCreated = 1;

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
	if (data.outcome === "failure") importance += 0.2;
	if (data.outcome === "partial") importance += 0.1;
	if (data.toolsUsed.length > 5) importance += 0.1;
	if (data.filesTracked.length > 0) importance += 0.1;
	return Math.min(importance, 1.0);
}

/**
 * HEURISTIC FALLBACK: heuristic fact extraction from user messages.
 * Looks for correction patterns, preferences, and explicit facts.
 */
function extractFactsFromSession(data: SessionData, episodeId: string): SemanticFact[] {
	const facts: SemanticFact[] = [];
	const now = new Date().toISOString();

	for (const message of data.userMessages) {
		const lower = message.toLowerCase();

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
