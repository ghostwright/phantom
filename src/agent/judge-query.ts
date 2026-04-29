import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { buildProviderEnv } from "../config/providers.ts";
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
	/**
	 * When true, the SDK is invoked with a plain-string `systemPrompt` instead
	 * of the `claude_code` preset envelope. The preset bundles the full Claude
	 * Code base prompt and tool catalog, which costs thousands of input tokens
	 * per call. Pure evaluation calls that do not use any tools (the
	 * conditional firing gate is the canonical example) should set this so
	 * Haiku only sees the judge prompt and the session summary, not the entire
	 * Claude Code surface area. Other judges that legitimately want the preset
	 * keep the default.
	 */
	omitPreset?: boolean;
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

// Partial cost captured from any pre-result streaming message. Phase 0 safety
// additions need this so that a subprocess that gets SIGKILLed before emitting
// its final `result` frame still leaves a visible footprint in metrics. Without
// this, fork-bomb API spend is invisible to the operator.
export type JudgePartialCost = {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	model: string;
	durationMs: number;
};

/**
 * Error thrown when the judge subprocess fails before producing a parseable
 * result. The `partialCost` field carries whatever usage information was
 * observed on the stream so callers can record the spend even when the
 * subprocess died mid-flight (SIGKILL, OOM, network timeout, etc.).
 */
export class JudgeSubprocessError extends Error {
	readonly partialCost: JudgePartialCost;

	constructor(message: string, partialCost: JudgePartialCost) {
		super(message);
		this.name = "JudgeSubprocessError";
		this.partialCost = partialCost;
	}
}

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

	// Judges must flow through the same provider as the main agent so that
	// auth, base URL, model mappings, and beta headers are consistent. Without
	// this, a Z.AI deployment would silently route judges back to Anthropic
	// whenever ANTHROPIC_API_KEY happened to be set in the shell.
	const providerEnv = buildProviderEnv(config);

	const systemPrompt = buildSystemPrompt(judgePrompt, options.omitPreset === true);

	const queryStream = query({
		prompt: options.userMessage,
		options: {
			model: resolvedModel,
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			systemPrompt,
			maxTurns: 1,
			effort: "low",
			persistSession: false,
			env: { ...process.env, ...providerEnv },
		},
	});

	let responseText = "";
	let inputTokens = 0;
	let outputTokens = 0;
	let resultCostUsd = 0;
	let errored: string | null = null;
	let gotResult = false;

	// Running totals of whatever usage we see on the stream before `result`
	// arrives. If the subprocess is SIGKILLed mid-flight (the fork-bomb failure
	// mode), these are the only numbers anyone will ever see for that call.
	const partial: JudgePartialCost = {
		inputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		model: resolvedModel,
		durationMs: 0,
	};

	const absorbUsage = (usage: unknown): void => {
		if (!usage || typeof usage !== "object") return;
		const u = usage as { input_tokens?: number; output_tokens?: number };
		if (typeof u.input_tokens === "number") partial.inputTokens += u.input_tokens;
		if (typeof u.output_tokens === "number") partial.outputTokens += u.output_tokens;
	};

	try {
		for await (const message of queryStream) {
			switch (message.type) {
				case "assistant": {
					// Assistant messages carry per-turn usage via the BetaMessage envelope.
					// We treat any usage field on any pre-result message as signal so the
					// partial cost survives a subprocess that never emits `result`.
					const betaMessage = (message as { message?: { usage?: unknown } }).message;
					if (betaMessage?.usage) absorbUsage(betaMessage.usage);
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
					gotResult = true;
					break;
				}
				default: {
					// Some non-assistant/non-result messages (system, task_*) also carry
					// usage. Absorb anything we can see so partial cost is as accurate as
					// possible without coupling to a specific subtype.
					const anyMsg = message as { usage?: unknown };
					if (anyMsg.usage) absorbUsage(anyMsg.usage);
					break;
				}
			}
		}
	} catch (err: unknown) {
		partial.durationMs = Date.now() - startTime;
		const msg = err instanceof Error ? err.message : String(err);
		throw new JudgeSubprocessError(`Judge subprocess stream failed: ${msg}`, partial);
	}

	if (!gotResult) {
		// Stream ended without a `result` frame at all. SIGKILL, process exit,
		// or transport close. Partial cost is the best we have.
		partial.durationMs = Date.now() - startTime;
		throw new JudgeSubprocessError("Judge subprocess ended before emitting result", partial);
	}

	if (errored) {
		partial.durationMs = Date.now() - startTime;
		// Prefer the `result` frame numbers when we actually got one, since the
		// SDK reports cumulative totals in that frame.
		partial.inputTokens = inputTokens || partial.inputTokens;
		partial.outputTokens = outputTokens || partial.outputTokens;
		partial.costUsd = resultCostUsd || partial.costUsd;
		throw new JudgeSubprocessError(`Judge subprocess ended with ${errored}`, partial);
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

/**
 * Test-only: absorb a stream of fake SDK messages into a `JudgePartialCost`
 * using exactly the same narrowing rules as `runJudgeQuery`. Exposed so the
 * partial-cost absorber can be exercised without spawning a real subprocess.
 * Do NOT use in production code: `runJudgeQuery` is the only call site the
 * runtime uses, and this helper is just a slice of its internal state machine.
 */
export function __absorbUsageForTest(
	messages: Iterable<unknown>,
	initial?: Partial<JudgePartialCost>,
): JudgePartialCost {
	const partial: JudgePartialCost = {
		inputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		model: "test",
		durationMs: 0,
		...initial,
	};
	const absorb = (usage: unknown): void => {
		if (!usage || typeof usage !== "object") return;
		const u = usage as { input_tokens?: number; output_tokens?: number };
		if (typeof u.input_tokens === "number") partial.inputTokens += u.input_tokens;
		if (typeof u.output_tokens === "number") partial.outputTokens += u.output_tokens;
	};
	for (const message of messages) {
		const m = message as { type?: string; message?: { usage?: unknown }; usage?: unknown };
		if (m.type === "assistant") {
			if (m.message?.usage) absorb(m.message.usage);
			continue;
		}
		if (m.type === "result") {
			// Production path reads cumulative numbers from the result frame; the
			// absorber is only the pre-result bookkeeper so we do not double count
			// here. This matches the `case "result"` branch in runJudgeQuery.
			continue;
		}
		if (m.usage) absorb(m.usage);
	}
	return partial;
}

/**
 * Compose the SDK `systemPrompt` value. The default path keeps the
 * `claude_code` preset envelope so judges designed against the Claude Code
 * tool catalog continue to receive the full base prompt. When the caller
 * sets `omitPreset`, the SDK is handed a plain string instead, which the
 * SDK documents as "Use a custom system prompt" and which skips the preset's
 * base prompt and tool descriptions entirely. The gate uses this to drop
 * two orders of magnitude of input tokens per call.
 */
export function buildSystemPrompt(
	judgePrompt: string,
	omitPreset: boolean,
): string | { type: "preset"; preset: "claude_code"; append: string } {
	if (omitPreset) {
		return judgePrompt;
	}
	return {
		type: "preset" as const,
		preset: "claude_code" as const,
		append: judgePrompt,
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
