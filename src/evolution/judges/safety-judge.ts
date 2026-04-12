import type { AgentRuntime } from "../../agent/runtime.ts";
import type { ConfigDelta } from "../types.ts";
import { callJudge, multiJudge } from "./client.ts";
import { safetyGatePrompt } from "./prompts.ts";
import { SafetyGateResult, type SafetyGateResultType } from "./schemas.ts";
import { JUDGE_MODEL_SONNET, type MultiJudgeResult } from "./types.ts";

/**
 * Triple-judge safety gate with minority veto.
 *
 * Runs 3 independent Sonnet judges in parallel. If ANY judge returns "fail"
 * with confidence > 0.7, the change is rejected. This maximizes safety at
 * the cost of a higher false-rejection rate, which is the correct tradeoff
 * for safety-critical gates.
 *
 * Fail-closed: if any judge call errors, the entire gate fails.
 */
export async function runSafetyJudge(
	runtime: AgentRuntime,
	delta: ConfigDelta,
	constitution: string,
	currentConfigText: string,
): Promise<MultiJudgeResult<SafetyGateResultType>> {
	const { system, user } = safetyGatePrompt(
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
			schema: SafetyGateResult,
			schemaName: "SafetyGateResult",
		});

	return multiJudge([makeJudge(), makeJudge(), makeJudge()], "minority_veto", 0.7);
}
