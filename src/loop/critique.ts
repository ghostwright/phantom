import { z } from "zod/v4";
import { callJudge } from "../evolution/judges/client.ts";
import { JUDGE_MODEL_SONNET, type JudgeCostEntry } from "../evolution/judges/types.ts";
import type { LoopTranscript } from "./post-loop.ts";

export type CritiqueResult = {
	assessment: string;
	cost: JudgeCostEntry;
};

const CritiqueSchema = z.object({ assessment: z.string() });

/**
 * Mid-loop critique: Sonnet 4.6 reviews the loop's progress every N ticks
 * to detect drift, stuck patterns, or wasted budget before the loop runs out.
 * Same cross-model pattern as interactive sessions (Sonnet judging Opus).
 */
export async function runCritiqueJudge(
	goal: string,
	stateFileContents: string,
	transcript: LoopTranscript,
	iteration: number,
	maxIterations: number,
): Promise<CritiqueResult> {
	const system = `You are a reviewer assessing an autonomous agent loop mid-flight.
The agent (Opus 4.6) is running inside a tight iteration loop toward a goal.
Your job is to assess whether the loop is making meaningful progress or if
it is stuck, drifting, or wasting budget. Be direct and actionable.`;

	const summaryBlock = transcript.summaries.length > 0 ? `\nTick summaries:\n${transcript.summaries.join("\n")}` : "";

	const user = `Goal: ${goal}

Progress (${iteration}/${maxIterations} ticks used):
${summaryBlock}

Current state file:
${stateFileContents.slice(0, 3000)}

Last response (truncated):
${transcript.lastResponse.slice(0, 1000)}

Is this loop making meaningful progress toward the goal? Is the agent stuck
in a pattern? Should it change approach? Give a brief (2-3 sentence) assessment
and one concrete suggestion if applicable.`;

	const result = await callJudge({
		model: JUDGE_MODEL_SONNET,
		systemPrompt: system,
		userMessage: user,
		schema: CritiqueSchema,
		schemaName: "LoopCritique",
		maxTokens: 500,
	});

	return {
		assessment: result.data.assessment,
		cost: {
			calls: 1,
			totalUsd: result.costUsd,
			totalInputTokens: result.inputTokens,
			totalOutputTokens: result.outputTokens,
		},
	};
}
