import type { AgentRuntime } from "../../agent/runtime.ts";
import type { EvolvedConfig, SessionSummary } from "../types.ts";
import { callJudge } from "./client.ts";
import { qualityAssessmentPrompt } from "./prompts.ts";
import { QualityAssessmentResult, type QualityAssessmentResultType } from "./schemas.ts";
import { JUDGE_MODEL_SONNET, type JudgeResult } from "./types.ts";

/**
 * Assess the overall quality of a session.
 * Feeds into the auto-rollback system: if quality degrades after a config
 * change, the system reverts. Multi-dimensional scoring catches subtle
 * degradation that binary success/fail would miss.
 */
export async function runQualityJudge(
	runtime: AgentRuntime,
	session: SessionSummary,
	currentConfig: EvolvedConfig,
): Promise<JudgeResult<QualityAssessmentResultType>> {
	const transcript = buildTranscript(session);
	const configText = buildConfigText(currentConfig);
	const duration = calculateDuration(session);

	const { system, user } = qualityAssessmentPrompt(
		configText,
		transcript,
		"auto",
		duration,
		"unknown",
		session.tools_used.join(", ") || "none",
	);

	return callJudge(runtime, {
		model: JUDGE_MODEL_SONNET,
		systemPrompt: system,
		userMessage: user,
		schema: QualityAssessmentResult,
		schemaName: "QualityAssessmentResult",
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

	lines.push("");
	lines.push(`Outcome: ${session.outcome}`);
	lines.push(`Cost: $${session.cost_usd.toFixed(4)}`);

	return lines.join("\n");
}

function buildConfigText(config: EvolvedConfig): string {
	return [
		"## Persona",
		config.persona,
		"",
		"## User Profile",
		config.userProfile,
		"",
		"## Domain Knowledge",
		config.domainKnowledge,
	].join("\n");
}

function calculateDuration(session: SessionSummary): string {
	const start = new Date(session.started_at).getTime();
	const end = new Date(session.ended_at).getTime();
	const seconds = Math.round((end - start) / 1000);
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${(seconds / 3600).toFixed(1)}h`;
}
