import type { AgentRuntime } from "../../agent/runtime.ts";
import type { ConfigDelta, GoldenCase } from "../types.ts";
import { callJudge } from "./client.ts";
import { regressionGatePrompt } from "./prompts.ts";
import { GoldenCaseJudgment } from "./schemas.ts";
import { JUDGE_MODEL_HAIKU, JUDGE_MODEL_SONNET, type JudgeResult } from "./types.ts";

type CaseJudgment = {
	caseId: string;
	verdict: "pass" | "fail" | "uncertain";
	confidence: number;
	reasoning: string;
	model: string;
	costUsd: number;
};

/**
 * Cascaded regression gate: Haiku first, escalate uncertain cases to Sonnet.
 *
 * Phase 1: Haiku evaluates each golden case independently (parallel).
 *   - confidence > 0.9 on all: accept Haiku's judgment
 *   - any case confidence < 0.9: escalate that case to Sonnet
 *
 * Phase 2: Sonnet re-evaluates only the uncertain cases.
 *   - Accept Sonnet's judgment regardless.
 *
 * Returns early with pass if the golden suite is empty.
 */
export async function runRegressionJudge(
	runtime: AgentRuntime,
	delta: ConfigDelta,
	goldenSuite: GoldenCase[],
	currentConfigText: string,
): Promise<{
	verdict: "pass" | "fail";
	confidence: number;
	reasoning: string;
	perCaseResults: CaseJudgment[];
	costUsd: number;
	durationMs: number;
}> {
	const startTime = Date.now();

	if (goldenSuite.length === 0) {
		return {
			verdict: "pass",
			confidence: 1.0,
			reasoning: "Golden suite is empty, no regression risk.",
			perCaseResults: [],
			costUsd: 0,
			durationMs: Date.now() - startTime,
		};
	}

	// Phase 1: Haiku evaluates all cases in parallel
	const haikuResults = await Promise.all(
		goldenSuite.map((gc) => evaluateCase(runtime, delta, gc, currentConfigText, JUDGE_MODEL_HAIKU)),
	);

	const results: CaseJudgment[] = [];
	const needsEscalation: Array<{ index: number; goldenCase: GoldenCase }> = [];
	let totalCost = 0;

	for (let i = 0; i < haikuResults.length; i++) {
		const hr = haikuResults[i];
		totalCost += hr.costUsd;

		if (hr.data.verdict === "fail") {
			// Haiku says fail - accept it
			results.push({
				caseId: goldenSuite[i].id,
				verdict: "fail",
				confidence: hr.data.confidence,
				reasoning: hr.data.reasoning,
				model: JUDGE_MODEL_HAIKU,
				costUsd: hr.costUsd,
			});
		} else if (hr.data.confidence >= 0.9 && hr.data.verdict === "pass") {
			// Haiku is confident it passes
			results.push({
				caseId: goldenSuite[i].id,
				verdict: "pass",
				confidence: hr.data.confidence,
				reasoning: hr.data.reasoning,
				model: JUDGE_MODEL_HAIKU,
				costUsd: hr.costUsd,
			});
		} else {
			// Uncertain - escalate to Sonnet
			needsEscalation.push({ index: i, goldenCase: goldenSuite[i] });
		}
	}

	// Phase 2: Sonnet re-evaluates uncertain cases
	if (needsEscalation.length > 0) {
		const sonnetResults = await Promise.all(
			needsEscalation.map(({ goldenCase }) =>
				evaluateCase(runtime, delta, goldenCase, currentConfigText, JUDGE_MODEL_SONNET),
			),
		);

		for (let i = 0; i < sonnetResults.length; i++) {
			const sr = sonnetResults[i];
			totalCost += sr.costUsd;

			const verdict = sr.data.verdict === "uncertain" ? "pass" : sr.data.verdict;
			results.push({
				caseId: needsEscalation[i].goldenCase.id,
				verdict,
				confidence: sr.data.confidence,
				reasoning: sr.data.reasoning,
				model: JUDGE_MODEL_SONNET,
				costUsd: sr.costUsd,
			});
		}
	}

	const failures = results.filter((r) => r.verdict === "fail");
	const overallVerdict = failures.length > 0 ? "fail" : "pass";
	const avgConfidence = results.reduce((sum, r) => sum + r.confidence, 0) / results.length;

	return {
		verdict: overallVerdict,
		confidence: avgConfidence,
		reasoning:
			failures.length > 0
				? `${failures.length} golden case(s) would regress: ${failures.map((f) => f.caseId).join(", ")}`
				: `All ${results.length} golden cases pass.`,
		perCaseResults: results,
		costUsd: totalCost,
		durationMs: Date.now() - startTime,
	};
}

async function evaluateCase(
	runtime: AgentRuntime,
	delta: ConfigDelta,
	goldenCase: GoldenCase,
	currentConfigText: string,
	model: string,
): Promise<JudgeResult<{ verdict: "pass" | "fail" | "uncertain"; confidence: number; reasoning: string }>> {
	const { system, user } = regressionGatePrompt(
		delta.file,
		delta.type,
		delta.content,
		delta.rationale,
		goldenCase.id,
		goldenCase.description,
		goldenCase.lesson,
		currentConfigText,
	);

	return callJudge(runtime, {
		model,
		systemPrompt: system,
		userMessage: user,
		schema: GoldenCaseJudgment,
		schemaName: "GoldenCaseJudgment",
	});
}
