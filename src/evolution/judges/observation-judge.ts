import type { AgentRuntime } from "../../agent/runtime.ts";
import type { EvolvedConfig, SessionObservation, SessionSummary } from "../types.ts";
import { callJudge } from "./client.ts";
import { observationExtractionPrompt } from "./prompts.ts";
import { ObservationExtractionResult, type ObservationExtractionResultType } from "./schemas.ts";
import { JUDGE_MODEL_SONNET, type JudgeResult } from "./types.ts";

/**
 * Use Sonnet to extract rich observations from a session transcript.
 * Returns structured observations that are far richer than regex matching.
 */
export async function extractObservationsWithJudge(
	runtime: AgentRuntime,
	session: SessionSummary,
	currentConfig: EvolvedConfig,
): Promise<JudgeResult<ObservationExtractionResultType>> {
	const transcript = buildTranscript(session);
	const configText = buildConfigText(currentConfig);
	const { system, user } = observationExtractionPrompt(transcript, configText);

	return callJudge(runtime, {
		model: JUDGE_MODEL_SONNET,
		systemPrompt: system,
		userMessage: user,
		schema: ObservationExtractionResult,
		schemaName: "ObservationExtractionResult",
	});
}

/**
 * Convert the LLM judge result to the existing SessionObservation format
 * used by the rest of the pipeline.
 */
export function toSessionObservations(result: ObservationExtractionResultType): SessionObservation[] {
	return result.observations.map((obs) => ({
		type: mapObservationType(obs.type),
		content: obs.summary,
		context: obs.detail,
		confidence: obs.importance,
		source_messages: [obs.evidence],
	}));
}

function mapObservationType(judgeType: string): SessionObservation["type"] {
	switch (judgeType) {
		case "explicit_correction":
		case "implicit_correction":
			return "correction";
		case "preference_stated":
		case "preference_inferred":
			return "preference";
		case "error_occurred":
		case "task_failed":
			return "error";
		case "task_succeeded":
		case "error_recovered":
			return "success";
		case "domain_fact_learned":
			return "domain_fact";
		case "workflow_pattern":
		case "tool_usage_insight":
		case "user_sentiment_signal":
			return "tool_pattern";
		default:
			return "tool_pattern";
	}
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
	lines.push(`Tools used: ${session.tools_used.join(", ") || "none"}`);
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
		"",
		`Version: ${config.meta.version}`,
	].join("\n");
}
