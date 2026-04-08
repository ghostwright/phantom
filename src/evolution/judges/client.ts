import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// zod/v4 required: matches schemas.ts for zodOutputFormat compatibility
import type { z } from "zod/v4";
import {
	JUDGE_MAX_TOKENS,
	JUDGE_TEMPERATURE,
	type JudgeResult,
	type MultiJudgeResult,
	type VotingStrategy,
} from "./types.ts";

/** Thrown when the API call succeeds but structured output parsing fails. Carries token usage so cost can still be tracked. */
export class JudgeParseError extends Error {
	constructor(
		message: string,
		public readonly inputTokens: number,
		public readonly outputTokens: number,
		public readonly costUsd: number,
	) {
		super(message);
		this.name = "JudgeParseError";
	}
}

let _client: Anthropic | null = null;

function getClient(): Anthropic {
	if (!_client) {
		// Prefer dedicated JUDGE_API_KEY for cost isolation and independent rate limits.
		// Falls back to ANTHROPIC_API_KEY, then OAuth tokens.
		const judgeKey = process.env.JUDGE_API_KEY || process.env.ANTHROPIC_API_KEY;
		if (judgeKey) {
			_client = new Anthropic({ apiKey: judgeKey });
		} else {
			const authToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined;
			_client = authToken ? new Anthropic({ authToken }) : new Anthropic();
		}
	}
	return _client;
}

// Visible for testing - allows injecting a mock client
export function setClient(client: Anthropic | null): void {
	_client = client;
}

export function isJudgeAvailable(): boolean {
	return !!(
		process.env.JUDGE_API_KEY ||
		process.env.ANTHROPIC_API_KEY ||
		process.env.ANTHROPIC_AUTH_TOKEN ||
		process.env.CLAUDE_CODE_OAUTH_TOKEN
	);
}

/**
 * Call a single LLM judge with structured output.
 * Uses the raw Anthropic SDK (not the Agent SDK).
 * Temperature 0 for deterministic judging.
 */
export async function callJudge<T>(options: {
	model: string;
	systemPrompt: string;
	userMessage: string;
	schema: z.ZodType<T>;
	schemaName?: string;
	maxTokens?: number;
}): Promise<JudgeResult<T>> {
	const client = getClient();
	const startTime = Date.now();

	const message = await client.messages.parse({
		model: options.model,
		max_tokens: options.maxTokens ?? JUDGE_MAX_TOKENS,
		temperature: JUDGE_TEMPERATURE,
		system: options.systemPrompt,
		messages: [{ role: "user", content: options.userMessage }],
		output_config: {
			// Cast needed: SDK .d.ts references zod v3 types but runtime uses zod/v4
			// biome-ignore lint/suspicious/noExplicitAny: bridging zod v3/v4 type mismatch
			format: zodOutputFormat(options.schema as any),
		},
	});

	const parsed = message.parsed_output;
	const inputTokens = message.usage.input_tokens;
	const outputTokens = message.usage.output_tokens;
	const costUsd = estimateCost(options.model, inputTokens, outputTokens);

	if (!parsed) {
		throw new JudgeParseError(
			`Judge returned no structured output (stop_reason: ${message.stop_reason})`,
			inputTokens,
			outputTokens,
			costUsd,
		);
	}

	// Extract verdict and confidence from the parsed data if present
	const data = parsed as Record<string, unknown>;
	const verdict = (data.verdict as "pass" | "fail") ?? "pass";
	const confidence = (data.confidence as number) ?? 1.0;
	const reasoning = (data.reasoning as string) ?? (data.overall_reasoning as string) ?? "";

	return {
		verdict,
		confidence,
		reasoning,
		data: parsed,
		model: options.model,
		inputTokens,
		outputTokens,
		costUsd,
		durationMs: Date.now() - startTime,
	};
}

/**
 * Run multiple judges in parallel and aggregate results.
 *
 * Strategies:
 * - minority_veto: ANY fail with confidence > threshold = overall fail
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
			// Any judge that fails with sufficient confidence vetoes
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

/**
 * Estimate USD cost from token counts.
 * Pricing as of March 2026.
 */
function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
	let inputPer1M: number;
	let outputPer1M: number;

	if (model.includes("opus")) {
		inputPer1M = 5.0;
		outputPer1M = 25.0;
	} else if (model.includes("haiku")) {
		inputPer1M = 1.0;
		outputPer1M = 5.0;
	} else {
		// Sonnet default
		inputPer1M = 3.0;
		outputPer1M = 15.0;
	}

	return (inputTokens / 1_000_000) * inputPer1M + (outputTokens / 1_000_000) * outputPer1M;
}
