import { query } from "@anthropic-ai/claude-agent-sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
// zod/v4 required: matches schemas.ts for judge output compatibility
import type { z } from "zod/v4";
import type {
	JudgeResult,
	MultiJudgeResult,
	VotingStrategy,
} from "./types.ts";
// JUDGE_MAX_TOKENS not used — SDK manages token limits internally

/**
 * Error thrown when a judge call fails but still incurred cost.
 * Callers should check for this to record spend toward the daily cap.
 */
export class JudgeError extends Error {
	costUsd: number;
	inputTokens: number;
	outputTokens: number;

	constructor(message: string, cost: { costUsd: number; inputTokens: number; outputTokens: number }) {
		super(message);
		this.name = "JudgeError";
		this.costUsd = cost.costUsd;
		this.inputTokens = cost.inputTokens;
		this.outputTokens = cost.outputTokens;
	}
}

/**
 * Judge availability check.
 * With the Agent SDK (Claude MAX OAuth), judges are always available —
 * no API key required.
 */
export function isJudgeAvailable(): boolean {
	return true;
}

/**
 * Call a single LLM judge with structured output via the Agent SDK.
 * Uses the SDK's native outputFormat for schema-constrained generation,
 * with tools disabled to prevent judges from executing code.
 */
export async function callJudge<T>(options: {
	model: string;
	systemPrompt: string;
	userMessage: string;
	schema: z.ZodType<T>;
	schemaName?: string;
	maxTokens?: number;
}): Promise<JudgeResult<T>> {
	const startTime = Date.now();

	// Cast needed: zod-to-json-schema types reference zod v3 but runtime uses zod/v4
	// biome-ignore lint/suspicious/noExplicitAny: bridging zod v3/v4 type mismatch
	const jsonSchema = zodToJsonSchema(options.schema as any) as Record<string, unknown>;

	let resultText = "";
	let totalCostUsd = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let isError = false;
	let errorReason = "";
	let structuredOutput: unknown = undefined;

	const queryStream = query({
		prompt: options.userMessage,
		options: {
			model: options.model,
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			systemPrompt: options.systemPrompt,
			persistSession: false,
			// Disable all tools — judges must only produce text/structured output
			tools: [],
			// Native structured output via the SDK
			outputFormat: {
				type: "json_schema" as const,
				schema: jsonSchema,
			},
			// Limit to 1 turn — judges should produce output in a single pass
			maxTurns: 1,
		},
	});

	for await (const message of queryStream) {
		switch (message.type) {
			case "assistant": {
				const text = message.message.content
					.filter((b: { type: string }) => b.type === "text")
					.map((b: { type: string; text?: string }) => b.text ?? "")
					.join("");
				if (text) resultText = text;
				break;
			}
			case "result": {
				const result = message as unknown as {
					subtype: string;
					is_error: boolean;
					total_cost_usd?: number;
					structured_output?: unknown;
					errors?: string[];
					modelUsage?: Record<
						string,
						{
							inputTokens: number;
							outputTokens: number;
							cacheReadInputTokens?: number;
							cacheCreationInputTokens?: number;
							costUSD: number;
						}
					>;
				};

				totalCostUsd = result.total_cost_usd ?? 0;
				isError = result.is_error;
				structuredOutput = result.structured_output;

				if (result.is_error) {
					errorReason = result.errors?.join("; ") ?? result.subtype;
				}

				if (result.modelUsage) {
					for (const usage of Object.values(result.modelUsage)) {
						inputTokens +=
							usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
						outputTokens += usage.outputTokens;
					}
				}
				break;
			}
		}
	}

	const costInfo = { costUsd: totalCostUsd, inputTokens, outputTokens };

	// Check for SDK-level errors before parsing
	if (isError) {
		throw new JudgeError(`Judge SDK error (${errorReason})`, costInfo);
	}

	// Prefer SDK structured_output, fall back to parsing assistant text
	let parsed: T;
	try {
		if (structuredOutput != null) {
			parsed = options.schema.parse(structuredOutput);
		} else {
			const cleaned = resultText.replace(/^```(?:json)?\s*\n?|\n?\s*```$/g, "").trim();
			parsed = options.schema.parse(JSON.parse(cleaned));
		}
	} catch (parseErr) {
		throw new JudgeError(
			`Judge output parsing failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
			costInfo,
		);
	}

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
		costUsd: totalCostUsd,
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
