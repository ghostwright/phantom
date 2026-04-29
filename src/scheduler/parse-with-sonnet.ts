// Sonnet describe-your-job assist.
//
// CARDINAL RULE: This endpoint helps the OPERATOR fill a form. The operator
// reviews and edits the structured output before saving. It does NOT classify
// user intent, and it does NOT drive the agent at run time. When the job
// fires, the agent gets the operator's final `task` prompt and decides what
// to do with it. Sonnet here is form plumbing, not a routing layer.
//
// Uses the Agent SDK subprocess via runtime.judgeQuery so the operator's
// existing auth (Claude subscription or ANTHROPIC_API_KEY) carries through
// the same path as every other LLM call in Phantom. Any failure - auth
// missing, network, timeout, malformed output - collapses to a 422 so the
// operator can fall back to manual entry without ceremony.

import { z as zv4 } from "zod/v4";
import type { AgentRuntime } from "../agent/runtime.ts";
import { type JobCreateInputParsed, JobCreateInputSchema } from "./tool-schema.ts";

export type ParseSuccess = { ok: true; proposal: JobCreateInputParsed; warnings: string[] };
export type ParseFailure = { ok: false; status: 422; error: string };
export type ParseResult = ParseSuccess | ParseFailure;

export type ParseDeps = {
	runtime?: AgentRuntime | null;
	model?: string;
};

const DEFAULT_MODEL = "claude-sonnet-4-6";
const GENERIC_ERROR = "Could not parse description, please fill the form manually.";

// Permissive v4 schema shape we hand to judgeQuery so its `z.toJSONSchema`
// call succeeds. We re-validate the returned object through the v3
// JobCreateInputSchema below, which is the single source of truth for the
// MCP tool, the create endpoint, and this helper. The v4 schema exists only
// because the Agent SDK judge path is typed against zod/v4.
const JudgeProposalSchema = zv4
	.object({
		name: zv4.string().min(1).max(200),
		description: zv4.string().max(1000).optional(),
		task: zv4.string().max(32 * 1024),
		schedule: zv4.union([
			zv4.object({ kind: zv4.literal("at"), at: zv4.string() }),
			zv4.object({ kind: zv4.literal("every"), intervalMs: zv4.number().int().positive() }),
			zv4.object({
				kind: zv4.literal("cron"),
				expr: zv4.string(),
				tz: zv4.string().optional(),
			}),
		]),
		delivery: zv4
			.object({
				channel: zv4.enum(["slack", "none"]).optional(),
				target: zv4.string().optional(),
			})
			.optional(),
		deleteAfterRun: zv4.boolean().optional(),
	})
	.passthrough();

type JudgeProposal = zv4.infer<typeof JudgeProposalSchema>;

const SYSTEM_PROMPT = [
	"You help an operator author a scheduled job for an autonomous AI agent.",
	"Convert their English description into structured fields.",
	"- name: kebab-case label.",
	"- task: imperative, self-contained instruction. The scheduled run does not see current context; include every URL, repo, channel.",
	'- schedule: one of { "kind":"at", "at":"<ISO 8601 with offset>" }, { "kind":"every", "intervalMs":<ms> }, { "kind":"cron", "expr":"<5-field>", "tz":"<IANA>" }.',
	'- delivery defaults to { "channel":"slack", "target":"owner" }.',
	"Heuristics:",
	"- 'every 6 hours' -> every, intervalMs 21600000.",
	"- '9am weekdays' -> cron '0 9 * * 1-5' tz America/Los_Angeles.",
	"- '9am daily' -> cron '0 9 * * *' tz America/Los_Angeles.",
	"- 'Friday 5pm' -> cron '0 17 * * 5' tz America/Los_Angeles.",
	"- Specific date/time -> at with ISO 8601 and explicit offset.",
	"Default timezone America/Los_Angeles if unspecified.",
	"If the description is incoherent, emit best-effort values and set task to the empty string so the operator fills it in.",
].join("\n");

/**
 * Call Sonnet via the Agent SDK subprocess and return a structured proposal
 * the operator can review before saving. Does not mutate state; the job is
 * created only when the operator hits Save in the UI.
 */
export async function parseJobDescription(description: string, deps: ParseDeps = {}): Promise<ParseResult> {
	if (!deps.runtime) {
		return { ok: false, status: 422, error: GENERIC_ERROR };
	}

	try {
		const result = await deps.runtime.judgeQuery<JudgeProposal>({
			systemPrompt: SYSTEM_PROMPT,
			userMessage: description,
			schema: JudgeProposalSchema,
			model: deps.model ?? DEFAULT_MODEL,
			maxTokens: 1024,
			omitPreset: true,
		});
		// Re-validate through the canonical v3 schema. Shared with the MCP
		// tool and the create endpoint so a proposal that would fail at
		// createJob is rejected here too.
		const parsed = JobCreateInputSchema.safeParse(result.data);
		if (!parsed.success) return { ok: false, status: 422, error: GENERIC_ERROR };
		return { ok: true, proposal: parsed.data, warnings: [] };
	} catch {
		return { ok: false, status: 422, error: GENERIC_ERROR };
	}
}
