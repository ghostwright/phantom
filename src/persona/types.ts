// Types for do_first_hour_of_work (architect §1.2). Shared across the
// runner, the renderer, the draft store, and the action handler.
//
// Architect: phantom-cloud-deploy/local/2026-05-03-slice-15-first-
// hour-of-work-architect.md.

export type DraftKind =
	| "email_reply"
	| "email_outbound"
	| "pr_comment"
	| "pr_review_request"
	| "slack_reply"
	| "slack_post"
	| "standup_post"
	| "check_in_message"
	| "experiment_writeup"
	| "briefing_paragraph"
	| "calendar_invite";

// ReasonCode taxonomy locked at 11 codes (architect §7.2). Builders may
// not introduce codes outside this set; the audit trail and the operator
// Grafana panel both pivot on these labels.
export type ReasonCode =
	| "ok"
	| "no_integrations_granted"
	| "all_pulls_zero_data"
	| "llm_error_mid_flow"
	| "zero_drafts_from_nonzero_data"
	| "integration_auth_expired"
	| "sixty_second_cap_hit"
	| "slack_post_failed"
	| "persona_unknown"
	| "fire_already_completed"
	| "internal_error";

export interface FirstHourOfWorkInput {
	persona_id: string;
	tenant_slug: string;
	owner_email: string;
	owner_name?: string;
	available_integrations: readonly string[];
	fire_id: string;
}

export interface PullExecuted {
	source: string;
	query: string;
	rows: number;
	error_kind?: string;
}

export interface DraftSummary {
	draft_id: string;
	kind: DraftKind;
	summary: string;
}

export interface FirstHourOfWorkOutput {
	ok: boolean;
	drafts_created: number;
	dm_message_id: string | null;
	duration_seconds: number;
	pulls_executed: PullExecuted[];
	drafts: DraftSummary[];
	reason_code: ReasonCode;
}

// PersistedDraft: the row shape persisted in the local SQLite phantom_
// drafts table at fire-time. The dashboard fetches via phantom-control
// (slice 15b); the in-VM phantom reads its own rows for resilience and
// for the action handler when Slack acts on a draft_id.
export interface PersistedDraft {
	draft_id: string;
	fire_id: string;
	persona_id: string;
	kind: DraftKind;
	summary: string;
	body: string;
	reference_url?: string;
	edit_hints?: string;
	status: "pending" | "approved" | "sent" | "skipped" | "edited" | "failed";
	slack_message_ts?: string;
	created_at: string;
	updated_at: string;
}

// AuditEvent: the five events fired per architect §7.1. The runner
// emits start, one pulls per pull, one drafts per draft, dm, finish.
// The audit sink lives in-process for v1; phantom-control receives a
// batched POST in slice 15b.
export type AuditEventKind =
	| "first_hour_of_work_start"
	| "first_hour_of_work_pulls"
	| "first_hour_of_work_drafts"
	| "first_hour_of_work_dm"
	| "first_hour_of_work_finish";

export interface AuditEvent {
	kind: AuditEventKind;
	tenant_slug: string;
	fire_id: string;
	persona_id: string;
	ts: string;
	// Free-form payload; the runner fills the kind-specific fields.
	payload: Record<string, unknown>;
}
