// Default LlmTurnCaller for production. Wraps the agent runtime with a
// firstboot session id prefix, hands the scaffold prompt over for one
// Sonnet turn, parses the FirstHourOfWorkOutput JSON envelope from the
// LLM's final text. Single turn, single tool, single decision boundary
// (architect §1.1).
//
// Slice 15a-followup will register phantom_save_draft + slack_post_dm_
// blocks as in-process tools gated by the session id prefix
// "first-hour:" so the LLM can call them inline. Until that lands the
// LLM is asked to emit the JSON envelope as its final message; the
// runner persists drafts and sends the DM on the LLM's behalf.
//
// The prompt's CARDINAL RULES already say "Output the JSON envelope
// as your FINAL message" so the parse step is contract-enforced.

import type { AgentRuntime } from "../agent/runtime.ts";
import type { LlmTurnCaller, LlmTurnRawDraft, LlmTurnResult } from "./runner.ts";
import type { DraftKind, PullExecuted } from "./types.ts";

export interface CreateLlmCallerDeps {
	runtime: AgentRuntime;
	channel?: string;
}

const VALID_DRAFT_KINDS: ReadonlySet<DraftKind> = new Set([
	"email_reply",
	"email_outbound",
	"pr_comment",
	"pr_review_request",
	"slack_reply",
	"slack_post",
	"standup_post",
	"check_in_message",
	"experiment_writeup",
	"briefing_paragraph",
	"calendar_invite",
]);

export function createDefaultLlmCaller(deps: CreateLlmCallerDeps): LlmTurnCaller {
	const channel = deps.channel ?? "scheduler";
	return async (req): Promise<LlmTurnResult> => {
		const conversationId = `first-hour:${randomConvSuffix()}`;
		try {
			const response = await deps.runtime.handleMessage(channel, conversationId, req.prompt);
			if (req.signal.aborted) {
				return {
					pulls_executed: [],
					saved_drafts: [],
				};
			}
			return parseEnvelope(response.text);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				pulls_executed: [],
				saved_drafts: [],
				llm_error: msg,
			};
		}
	};
}

// parseEnvelope: extract the JSON envelope from the LLM's final text.
// Tolerates a markdown fence around the JSON (the model occasionally
// renders ```json ... ``` even when told not to). Drops drafts whose
// kind is not in the allowed set. Drops drafts without a body.
export function parseEnvelope(text: string): LlmTurnResult {
	const json = extractJsonBlock(text);
	if (!json) {
		return {
			pulls_executed: [],
			saved_drafts: [],
			llm_error: "no_json_envelope",
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return {
			pulls_executed: [],
			saved_drafts: [],
			llm_error: "envelope_parse_error",
		};
	}
	if (!parsed || typeof parsed !== "object") {
		return {
			pulls_executed: [],
			saved_drafts: [],
			llm_error: "envelope_shape_error",
		};
	}

	const obj = parsed as Record<string, unknown>;

	const pullsRaw = Array.isArray(obj.pulls_executed) ? obj.pulls_executed : [];
	const pulls: PullExecuted[] = [];
	for (const item of pullsRaw) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		const source = typeof o.source === "string" ? o.source : null;
		if (!source) continue;
		pulls.push({
			source,
			query: typeof o.query === "string" ? o.query : "",
			rows: Number.isFinite(o.rows as number) ? Number(o.rows) : 0,
			error_kind: typeof o.error_kind === "string" ? o.error_kind : undefined,
		});
	}

	const draftsRaw = Array.isArray(obj.drafts) ? obj.drafts : [];
	const drafts: LlmTurnRawDraft[] = [];
	for (const item of draftsRaw) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		const kind = typeof o.kind === "string" ? o.kind : null;
		if (!kind || !VALID_DRAFT_KINDS.has(kind as DraftKind)) continue;
		const summary = typeof o.summary === "string" ? o.summary : "";
		const body = typeof o.body === "string" ? o.body : "";
		if (!body) continue;
		drafts.push({
			kind: kind as DraftKind,
			summary,
			body,
			reference_url: typeof o.reference_url === "string" ? o.reference_url : undefined,
			edit_hints: typeof o.edit_hints === "string" ? o.edit_hints : undefined,
		});
	}

	const expired = typeof obj.expired_provider === "string" ? obj.expired_provider : undefined;
	const llmError = typeof obj.llm_error === "string" ? obj.llm_error : undefined;

	return {
		pulls_executed: pulls,
		saved_drafts: drafts,
		expired_provider: expired,
		llm_error: llmError,
	};
}

function extractJsonBlock(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced?.[1]) {
		return fenced[1].trim();
	}
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return trimmed.slice(firstBrace, lastBrace + 1);
	}
	return null;
}

function randomConvSuffix(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
