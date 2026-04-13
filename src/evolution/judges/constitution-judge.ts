import type { AgentRuntime } from "../../agent/runtime.ts";
import type { ConfigDelta } from "../types.ts";
import { callJudge, multiJudge } from "./client.ts";
import { constitutionGatePrompt } from "./prompts.ts";
import { ConstitutionGateResult, type ConstitutionGateResultType } from "./schemas.ts";
import { JUDGE_MODEL_SONNET, type MultiJudgeResult } from "./types.ts";

/**
 * Triple-judge constitution gate with minority veto.
 *
 * Runs 3 independent Sonnet judges in parallel. If ANY judge finds a
 * constitutional violation with confidence > 0.7, the change is rejected.
 *
 * Fail-closed: if any judge call errors, the entire gate fails.
 */
export async function runConstitutionJudge(
	runtime: AgentRuntime,
	delta: ConfigDelta,
	constitution: string,
	currentConfigText: string,
): Promise<MultiJudgeResult<ConstitutionGateResultType>> {
	const { system, user } = constitutionGatePrompt(
		constitution,
		delta.file,
		delta.type,
		delta.content,
		delta.rationale,
		currentConfigText,
	);

	const makeJudge = () => () =>
		callJudge(runtime, {
			model: JUDGE_MODEL_SONNET,
			systemPrompt: system,
			userMessage: user,
			schema: ConstitutionGateResult,
			schemaName: "ConstitutionGateResult",
		});

	return multiJudge([makeJudge(), makeJudge(), makeJudge()], "minority_veto", 0.7);
}
