import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { PhantomConfig } from "../config/types.ts";
import { extractTextFromMessage } from "./message-utils.ts";

// Judge subprocess integration. Routes LLM judge calls through the same
// Agent SDK `query()` subprocess as the main agent so that auth, provider,
// and base URL flow through a single path. The older raw Anthropic SDK
// integration (`client.messages.parse`) is gone; structured output is now
// produced by prompt instruction + JSON.parse + Zod validation.

export type JudgeQueryOptions<T> = {
	systemPrompt: string;
	userMessage: string;
	schema: z.ZodType<T>;
	model?: string;
	maxTokens?: number;
};

export type JudgeQueryResult<T> = {
	verdict: "pass" | "fail";
	confidence: number;
	reasoning: string;
	data: T;
	model: string;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	durationMs: number;
};

// Minimum permissive schema shape so we can surface verdict/confidence/reasoning
// on the envelope when the concrete schema opts into those fields.
type JudgeEnvelopeFields = {
	verdict?: "pass" | "fail";
	confidence?: number;
	reasoning?: string;
	overall_reasoning?: string;
};

const JSON_BLOCK = /^```(?:json)?\s*\n?/;
const TRAILING_BLOCK = /\n?```\s*$/;

/**
 * Parse and validate a JSON response returned by a judge subprocess.
 *
 * Handles three common model output shapes:
 *  1. Raw JSON object (preferred, matches the prompt instruction)
 *  2. JSON wrapped in a ```json ... ``` code fence
 *  3. Prose around a JSON object, recovered by taking the substring from the
 *     first `{` to the last `}`
 *
 * Any remaining format noise causes a clear error. Zod validation catches
 * structural mismatches. No silent fallback to partial data.
 */
export function parseJsonFromResponse<T>(text: string, schema: z.ZodType<T>): T {
	if (!text || text.trim().length === 0) {
		throw new Error("Judge returned empty response");
	}

	let cleaned = text.trim();
	if (cleaned.startsWith("```")) {
		cleaned = cleaned.replace(JSON_BLOCK, "").replace(TRAILING_BLOCK, "").trim();
	}

	let raw: unknown;
	try {
		raw = JSON.parse(cleaned);
	} catch {
		// Second chance: find the outermost JSON object in the text.
		// Useful when a model prepends/appends commentary despite the prompt.
		const firstBrace = cleaned.indexOf("{");
		const lastBrace = cleaned.lastIndexOf("}");
		if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
			throw new Error(`Judge returned non-JSON response: ${truncate(text, 200)}`);
		}
		try {
			raw = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Judge returned invalid JSON: ${msg}. Response: ${truncate(text, 200)}`);
		}
	}

	const result = schema.safeParse(raw);
	if (!result.success) {
		throw new Error(`Judge output failed schema validation: ${formatZodError(result.error)}`);
	}
	return result.data;
}

/**
 * Run a focused evaluation query through the Agent SDK subprocess.
 *
 * The judge prompt is assembled from the caller's system prompt plus a JSON
 * schema contract. `maxTurns: 1` and `effort: "low"` keep judge latency and
 * cost bounded; MCP servers, hooks, and session persistence are all disabled
 * because judges are stateless evaluators, not interactive agents.
 */
export async function runJudgeQuery<T>(
	config: PhantomConfig,
	options: JudgeQueryOptions<T>,
): Promise<JudgeQueryResult<T>> {
	const startTime = Date.now();
	const resolvedModel = options.model ?? config.judge_model ?? config.model;

	const schemaJson = z.toJSONSchema(options.schema);
	const judgePrompt = buildJudgePrompt(options.systemPrompt, schemaJson);

	const queryStream = query({
		prompt: options.userMessage,
		options: {
			model: resolvedModel,
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			systemPrompt: {
				type: "preset" as const,
				preset: "claude_code" as const,
				append: judgePrompt,
			},
			maxTurns: 1,
			effort: "low",
			persistSession: false,
		},
	});

	let responseText = "";
	let inputTokens = 0;
	let outputTokens = 0;
	let resultCostUsd = 0;
	let errored: string | null = null;

	for await (const message of queryStream) {
		switch (message.type) {
			case "assistant": {
				const content = extractTextFromMessage(message.message);
				if (content) responseText = content;
				break;
			}
			case "result": {
				const msg = message as {
					subtype: string;
					result?: string;
					total_cost_usd?: number;
					usage?: { input_tokens?: number; output_tokens?: number };
				};
				if (msg.subtype === "success" && msg.result) {
					responseText = msg.result;
				}
				if (msg.subtype !== "success") {
					errored = msg.subtype;
				}
				inputTokens = msg.usage?.input_tokens ?? 0;
				outputTokens = msg.usage?.output_tokens ?? 0;
				resultCostUsd = msg.total_cost_usd ?? 0;
				break;
			}
		}
	}

	if (errored) {
		throw new Error(`Judge subprocess ended with ${errored}`);
	}

	const parsed = parseJsonFromResponse<T>(responseText, options.schema);
	const envelope = parsed as T & JudgeEnvelopeFields;

	return {
		verdict: envelope.verdict ?? "pass",
		confidence: typeof envelope.confidence === "number" ? envelope.confidence : 1.0,
		reasoning: envelope.reasoning ?? envelope.overall_reasoning ?? "",
		data: parsed,
		model: resolvedModel,
		inputTokens,
		outputTokens,
		costUsd: resultCostUsd,
		durationMs: Date.now() - startTime,
	};
}

function buildJudgePrompt(systemPrompt: string, schemaJson: unknown): string {
	return [
		systemPrompt,
		"",
		"You MUST respond with ONLY a JSON object that conforms to the schema below.",
		"Do not include markdown code fences, prose, explanations, or any text outside the JSON object.",
		"The first character of your response must be `{` and the last must be `}`.",
		"",
		"Schema:",
		JSON.stringify(schemaJson, null, 2),
	].join("\n");
}

function formatZodError(error: z.ZodError): string {
	const issues = error.issues.slice(0, 3).map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
		return `${path}: ${issue.message}`;
	});
	const suffix = error.issues.length > 3 ? ` (+${error.issues.length - 3} more)` : "";
	return `${issues.join("; ")}${suffix}`;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}...`;
}
