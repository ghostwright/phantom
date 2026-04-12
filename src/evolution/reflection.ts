import type { AgentRuntime } from "../agent/runtime.ts";
import { matchesCorrectionPattern, matchesDomainFactPattern, matchesPreferencePattern } from "../shared/patterns.ts";
import type { EvolutionConfig } from "./config.ts";
import { extractObservationsWithJudge, toSessionObservations } from "./judges/observation-judge.ts";
import type { JudgeCostEntry } from "./judges/types.ts";
import type { ConfigDelta, CritiqueResult, EvolvedConfig, SessionObservation, SessionSummary } from "./types.ts";

/**
 * Step 1: Extract observations using Sonnet judge, with regex fallback.
 * The judge extracts implicit corrections, inferred preferences, and
 * sentiment signals that regex cannot detect.
 */
export async function extractObservationsWithLLM(
	runtime: AgentRuntime,
	session: SessionSummary,
	currentConfig: EvolvedConfig,
): Promise<{ observations: SessionObservation[]; judgeCost: JudgeCostEntry | null }> {
	try {
		const result = await extractObservationsWithJudge(runtime, session, currentConfig);
		const observations = toSessionObservations(result.data);
		return {
			observations: observations.length > 0 ? observations : extractObservations(session),
			judgeCost: {
				calls: 1,
				totalUsd: result.costUsd,
				totalInputTokens: result.inputTokens,
				totalOutputTokens: result.outputTokens,
			},
		};
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);
		console.warn(`[evolution] Observation judge failed, falling back to heuristic: ${msg}`);
		return { observations: extractObservations(session), judgeCost: null };
	}
}

/**
 * HEURISTIC FALLBACK: Only runs when LLM judges are unavailable.
 * Do NOT expand these patterns. If coverage is insufficient,
 * fix the LLM judge availability instead.
 *
 * Step 1 (heuristic fallback): Extract observations via regex patterns.
 */
export function extractObservations(session: SessionSummary): SessionObservation[] {
	const observations: SessionObservation[] = [];

	for (const message of session.user_messages) {
		const lower = message.toLowerCase();

		if (matchesCorrectionPattern(lower)) {
			observations.push({
				type: "correction",
				content: message,
				context: `User corrected the agent during session ${session.session_id}`,
				confidence: 0.85,
				source_messages: [message],
			});
		}

		if (matchesPreferencePattern(lower)) {
			observations.push({
				type: "preference",
				content: message,
				context: `User expressed a preference during session ${session.session_id}`,
				confidence: 0.9,
				source_messages: [message],
			});
		}

		if (matchesDomainFactPattern(lower)) {
			observations.push({
				type: "domain_fact",
				content: message,
				context: `User shared domain knowledge during session ${session.session_id}`,
				confidence: 0.75,
				source_messages: [message],
			});
		}
	}

	if (session.outcome === "failure") {
		observations.push({
			type: "error",
			content: `Session ${session.session_id} ended in failure`,
			context: `Task failed. Messages: ${session.user_messages.join(" | ")}`,
			confidence: 0.95,
			source_messages: session.user_messages,
		});
	}

	if (session.outcome === "success") {
		observations.push({
			type: "success",
			content: `Session ${session.session_id} completed successfully`,
			context: `Task succeeded. Cost: $${session.cost_usd.toFixed(4)}`,
			confidence: 0.95,
			source_messages: [],
		});
	}

	if (session.tools_used.length > 0) {
		observations.push({
			type: "tool_pattern",
			content: `Tools used: ${session.tools_used.join(", ")}`,
			context: `Tool usage pattern in session ${session.session_id}`,
			confidence: 0.7,
			source_messages: [],
		});
	}

	return observations;
}

/**
 * Step 2: Self-critique via a separate agent call.
 *
 * Uses the Claude Agent SDK query() with structured output. This MUST be
 * a separate call from the main session to prevent self-serving bias
 * (supported by Multi-Agent Reflexion research).
 *
 * When the SDK is not available (tests, offline), falls back to
 * heuristic critique generation from observations.
 */
export async function selfCritique(
	observations: SessionObservation[],
	currentConfig: EvolvedConfig,
	_evolutionConfig: EvolutionConfig,
	session: SessionSummary,
): Promise<CritiqueResult> {
	// Build the critique from observations directly.
	// The separate LLM reflection call is wired in the engine when the SDK is available.
	return buildCritiqueFromObservations(observations, session, currentConfig);
}

/**
 * Build a critique result from observations without an LLM call.
 * Used as the default implementation and as a fallback.
 */
export function buildCritiqueFromObservations(
	observations: SessionObservation[],
	session: SessionSummary,
	_currentConfig: EvolvedConfig,
): CritiqueResult {
	const corrections = observations.filter((o) => o.type === "correction");
	const preferences = observations.filter((o) => o.type === "preference");
	const errors = observations.filter((o) => o.type === "error");
	const successes = observations.filter((o) => o.type === "success");

	const suggestedChanges: CritiqueResult["suggested_changes"] = [];

	// Corrections become user-profile changes
	for (const correction of corrections) {
		suggestedChanges.push({
			file: "user-profile.md",
			type: "append",
			content: `- ${distillCorrection(correction.content)}`,
			rationale: `User correction in session ${session.session_id}: "${correction.content.slice(0, 100)}"`,
			tier: "free",
		});
	}

	// Preferences become user-profile changes
	for (const preference of preferences) {
		suggestedChanges.push({
			file: "user-profile.md",
			type: "append",
			content: `- ${distillPreference(preference.content)}`,
			rationale: `User preference in session ${session.session_id}: "${preference.content.slice(0, 100)}"`,
			tier: "free",
		});
	}

	return {
		overall_assessment: session.outcome === "success" ? "Session completed successfully." : "Session had issues.",
		what_worked: successes.map((s) => s.content),
		what_failed: errors.map((e) => e.content),
		corrections_detected: corrections.map((c) => c.content),
		suggested_changes: suggestedChanges,
	};
}

/**
 * Step 3: Generate config deltas from the critique.
 * Converts critique suggestions into atomic, validated ConfigDelta objects.
 */
export function generateDeltas(critique: CritiqueResult, sessionId: string): ConfigDelta[] {
	return critique.suggested_changes.map((change) => ({
		file: change.file,
		type: change.type,
		content: change.content,
		target: change.target,
		rationale: change.rationale,
		session_ids: [sessionId],
		tier: change.tier,
	}));
}

/**
 * Build the reflection prompt for the separate LLM critique call.
 */
export function buildReflectionPrompt(
	observations: SessionObservation[],
	currentConfig: EvolvedConfig,
	session: SessionSummary,
): string {
	const configSummary = [
		"## Current Configuration",
		"",
		"### Persona",
		currentConfig.persona,
		"",
		"### User Profile",
		currentConfig.userProfile,
		"",
		"### Domain Knowledge",
		currentConfig.domainKnowledge,
		"",
		`### Version: ${currentConfig.meta.version}`,
	].join("\n");

	const observationText = observations
		.map((o) => `- [${o.type}] (confidence: ${o.confidence}) ${o.content}`)
		.join("\n");

	const sessionText = [
		"## Session Summary",
		`Session ID: ${session.session_id}`,
		`Outcome: ${session.outcome}`,
		`Cost: $${session.cost_usd.toFixed(4)}`,
		`User messages: ${session.user_messages.length}`,
		"",
		"### User Messages",
		...session.user_messages.map((m) => `> ${m}`),
		"",
		"### Observations",
		observationText,
	].join("\n");

	return [
		"You are a reflection agent reviewing a completed session. Your job is to identify",
		"what went well, what went wrong, and suggest specific, minimal config changes.",
		"",
		"Analyze the session and current configuration. For each suggested change:",
		'- Specify the file (e.g., "user-profile.md")',
		'- Specify the type ("append", "replace", or "remove")',
		"- Provide the exact content to add/replace",
		"- Explain why this change is needed",
		'- Specify the tier ("immutable", "constrained", or "free")',
		"",
		"Be conservative. Only suggest changes supported by clear evidence from the session.",
		"Do not suggest changes to constitution.md (it is immutable).",
		"",
		configSummary,
		"",
		sessionText,
	].join("\n");
}

/**
 * Build the JSON schema for structured critique output.
 */
export function getCritiqueJsonSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			overall_assessment: { type: "string" },
			what_worked: { type: "array", items: { type: "string" } },
			what_failed: { type: "array", items: { type: "string" } },
			corrections_detected: { type: "array", items: { type: "string" } },
			suggested_changes: {
				type: "array",
				items: {
					type: "object",
					properties: {
						file: { type: "string" },
						type: { type: "string", enum: ["append", "replace", "remove"] },
						content: { type: "string" },
						target: { type: "string" },
						rationale: { type: "string" },
						tier: { type: "string", enum: ["immutable", "constrained", "free"] },
					},
					required: ["file", "type", "content", "rationale", "tier"],
				},
			},
		},
		required: ["overall_assessment", "what_worked", "what_failed", "corrections_detected", "suggested_changes"],
	};
}

function distillCorrection(message: string): string {
	// Remove common correction prefixes to get the actual content
	return message
		.replace(/^(no[,.]?\s*|actually[,.]?\s*|that'?s\s*(not|wrong|incorrect)[,.]?\s*|it\s+should\s+be\s*)/i, "")
		.trim();
}

function distillPreference(message: string): string {
	return message.replace(/^(i\s+prefer\s*|always\s+use\s*|never\s+(use|do)\s*|please\s+(always|never)\s*)/i, "").trim();
}
