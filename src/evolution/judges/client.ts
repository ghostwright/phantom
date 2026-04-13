// zod/v4 required: matches schemas.ts so judge schemas flow through unchanged.
import type { z } from "zod/v4";
import type { AgentRuntime } from "../../agent/runtime.ts";
import type { JudgeResult, MultiJudgeResult, VotingStrategy } from "./types.ts";

// Judges used to live on the raw Anthropic SDK (`client.messages.parse`). They now
// route through the same Agent SDK subprocess as the main agent, so a single auth
// path and a single provider env var control both tiers. The shape of this module
// is deliberately small: it exists to delegate, not to own its own transport.

/**
 * Back-compat signal: does the judge machinery have any hope of running?
 *
 * With the old raw-SDK design this checked `ANTHROPIC_API_KEY`. Under the
 * subprocess design, authentication is handled by the Claude Code CLI itself
 * (via `claude login`, custom base URLs, or env vars like `ANTHROPIC_BASE_URL`).
 * There is no reliable way to introspect CLI auth status from this module,
 * and a failed subprocess call will surface a clear error anyway. Returning
 * `true` preserves any callers without reintroducing an auth coupling.
 */
export function isJudgeAvailable(): boolean {
	return true;
}

/**
 * Call a single LLM judge with structured output.
 *
 * Returns a `JudgeResult<T>` matching the pre-subprocess contract so every
 * downstream judge (safety, constitution, observation, etc.) and the voting
 * logic in `multiJudge()` continue to work without changes to their shape.
 */
export async function callJudge<T>(
	runtime: AgentRuntime,
	options: {
		model: string;
		systemPrompt: string;
		userMessage: string;
		schema: z.ZodType<T>;
		schemaName?: string;
		maxTokens?: number;
	},
): Promise<JudgeResult<T>> {
	const result = await runtime.judgeQuery<T>({
		systemPrompt: options.systemPrompt,
		userMessage: options.userMessage,
		schema: options.schema,
		model: options.model,
		maxTokens: options.maxTokens,
	});

	return {
		verdict: result.verdict,
		confidence: result.confidence,
		reasoning: result.reasoning,
		data: result.data,
		model: result.model,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		costUsd: result.costUsd,
		durationMs: result.durationMs,
	};
}

/**
 * Run multiple judges in parallel and aggregate results.
 *
 * Strategies:
 * - minority_veto: ANY fail with confidence >= threshold = overall fail
 * - majority: >50% must agree on the verdict
 * - unanimous: ALL must agree
 */
export async function multiJudge<T>(
	judges: Array<() => Promise<JudgeResult<T>>>,
	strategy: VotingStrategy,
	confidenceThreshold = 0.7,
): Promise<MultiJudgeResult<T>> {
	const startTime = Date.now();
	const results = await Promise.all(judges.map((fn) => fn()));

	const totalCost = results.reduce((sum, r) => sum + r.costUsd, 0);

	switch (strategy) {
		case "minority_veto": {
			const vetoes = results.filter((r) => r.verdict === "fail" && r.confidence >= confidenceThreshold);
			const verdict = vetoes.length > 0 ? "fail" : "pass";
			const reasoning =
				vetoes.length > 0
					? `Vetoed by ${vetoes.length}/${results.length} judge(s): ${vetoes.map((v) => v.reasoning).join(" | ")}`
					: `All ${results.length} judges passed.`;
			const avgConfidence = results.reduce((sum, r) => sum + r.confidence, 0) / results.length;

			return {
				verdict,
				confidence: avgConfidence,
				reasoning,
				individualResults: results,
				strategy,
				costUsd: totalCost,
				durationMs: Date.now() - startTime,
			};
		}

		case "majority": {
			const passCount = results.filter((r) => r.verdict === "pass").length;
			const verdict = passCount > results.length / 2 ? "pass" : "fail";
			const avgConfidence = results.reduce((sum, r) => sum + r.confidence, 0) / results.length;

			return {
				verdict,
				confidence: avgConfidence,
				reasoning: `${passCount}/${results.length} judges voted pass.`,
				individualResults: results,
				strategy,
				costUsd: totalCost,
				durationMs: Date.now() - startTime,
			};
		}

		case "unanimous": {
			const allPass = results.every((r) => r.verdict === "pass");
			const verdict = allPass ? "pass" : "fail";
			const minConfidence = Math.min(...results.map((r) => r.confidence));

			return {
				verdict,
				confidence: minConfidence,
				reasoning: allPass
					? `All ${results.length} judges unanimously passed.`
					: `${results.filter((r) => r.verdict === "fail").length} judge(s) voted fail.`,
				individualResults: results,
				strategy,
				costUsd: totalCost,
				durationMs: Date.now() - startTime,
			};
		}
	}
}
