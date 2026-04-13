import type { AgentRuntime } from "../../agent/runtime.ts";
import type { SessionSummary } from "../types.ts";
import { callJudge } from "./client.ts";
import { consolidationPrompt } from "./prompts.ts";
import { ConsolidationJudgeResult, type ConsolidationJudgeResultType } from "./schemas.ts";
import { JUDGE_MODEL_SONNET, type JudgeResult } from "./types.ts";

/**
 * Use Sonnet to extract structured knowledge from a session for long-term memory.
 * Much richer than regex-based extraction: detects implicit preferences,
 * contradictions with existing knowledge, and repeatable procedures.
 */
export async function runConsolidationJudge(
	runtime: AgentRuntime,
	session: SessionSummary,
	existingFacts: string,
): Promise<JudgeResult<ConsolidationJudgeResultType>> {
	const transcript = buildTranscript(session);
	const duration = calculateDuration(session);
	const toolsUsed = session.tools_used.join(", ") || "none";

	const { system, user } = consolidationPrompt(
		transcript,
		existingFacts || "No existing facts yet.",
		duration,
		toolsUsed,
		"auto",
		session.outcome,
	);

	return callJudge(runtime, {
		model: JUDGE_MODEL_SONNET,
		systemPrompt: system,
		userMessage: user,
		schema: ConsolidationJudgeResult,
		schemaName: "ConsolidationJudgeResult",
	});
}

function buildTranscript(session: SessionSummary): string {
	const lines: string[] = [];
	const maxTurns = Math.max(session.user_messages.length, session.assistant_messages.length);

	for (let i = 0; i < maxTurns; i++) {
		if (i < session.user_messages.length) {
			lines.push(`User: ${session.user_messages[i]}`);
		}
		if (i < session.assistant_messages.length) {
			lines.push(`Assistant: ${session.assistant_messages[i]}`);
		}
	}

	return lines.join("\n");
}

function calculateDuration(session: SessionSummary): string {
	const start = new Date(session.started_at).getTime();
	const end = new Date(session.ended_at).getTime();
	const seconds = Math.round((end - start) / 1000);

	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${(seconds / 3600).toFixed(1)}h`;
}
