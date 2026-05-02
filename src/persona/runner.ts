// runFirstHourOfWorkOnFirstboot: end-to-end orchestrator for the
// do_first_hour_of_work primitive (architect §1, §3, §4.1, §6).
//
// Flow:
//   1. Pre-fire ledger gate (idempotency layer 1 from architect §3.4).
//   2. Resolve persona work plan; unknown id -> fire_already_completed
//      reason after silent skip (architect §7.2 persona_unknown
//      surfaces in audit, never as a DM).
//   3. Resolve granted integrations via the env-var grant reader.
//   4. Filter persona's required_integrations against the grants. If
//      the intersection is empty AND the persona has any required
//      integrations declared, send the no_integrations_granted DM
//      (architect §6.1).
//   5. Build the scaffold prompt; call the injected LLM with an
//      AbortController scoped to the persona's hard cap (default 60s,
//      architect §6.6).
//   6. Parse the JSON envelope the LLM emits as its final message.
//      Persist each draft locally and POST to phantom-control via the
//      injected draft sink (slice 15b lands the real endpoint).
//   7. Render the Block Kit DM, send via the injected slack sender,
//      record the message ts on the firstboot ledger.
//   8. Emit the five audit events (architect §7.1) via the injected
//      audit sink. Mark the ledger completed.
//
// Single Sonnet turn, single tool, single prompt-pinned 4-step
// structure. No chain of separate LLM agents (architect §1.1).
//
// Deps are injected so tests can drive every failure mode without a
// real Slack workspace, real metadata gateway, or real LLM. The
// runner returns the FirstHourOfWorkOutput envelope it built; the
// caller does not need to interpret reason codes (the DM and audit
// events already covered the surfaces).

import type { SlackBlock } from "../channels/feedback.ts";
import {
	type FirstHourDmDraft,
	renderFirstHourDmBlocks,
	renderFirstHourDmFallbackBlocks,
	renderFirstHourDmFallbackText,
} from "../channels/slack/render-first-hour-dm.ts";
import { readGrantedIntegrations } from "../integrations/grants.ts";
import { dmTextForReason } from "./failure-modes.ts";
import { buildScaffoldPrompt, resolvePersonaSubtitle } from "./scaffold-prompt.ts";
import type {
	AuditEvent,
	AuditEventKind,
	DraftKind,
	FirstHourOfWorkInput,
	FirstHourOfWorkOutput,
	PullExecuted,
	ReasonCode,
} from "./types.ts";
import { type PersonaWorkPlan, filterIntegrationsByGrants, getPersonaWorkPlan } from "./work-plans.ts";

// LlmTurnRequest: the shape the runner hands the LLM caller. The runner
// owns the prompt; the caller owns the model dispatch (subprocess SDK
// in production, mock in tests).
export interface LlmTurnRequest {
	prompt: string;
	persona: PersonaWorkPlan;
	available_integrations: readonly string[];
	signal: AbortSignal;
}

// LlmTurnResult: the parsed envelope. The runner is responsible for the
// JSON parse; the caller emits raw text and a list of draft bodies the
// LLM "saved" via the phantom_save_draft tool. The caller's contract:
// drafts are saved in the order the LLM emits them, the envelope's
// drafts_summary holds the same ids back-mapped, and any save errors
// are surfaced via the saved_drafts.error field.
export interface LlmTurnRawDraft {
	kind: DraftKind;
	summary: string;
	body: string;
	reference_url?: string;
	edit_hints?: string;
}

export interface LlmTurnResult {
	pulls_executed: PullExecuted[];
	saved_drafts: LlmTurnRawDraft[];
	// integration_auth_expired: when the LLM caller observed a 401/410
	// from a pull and the runner should switch to the auth-expired
	// failure mode. The runner uses expired_provider on the DM.
	expired_provider?: string;
	// llm_error: when the model surfaced an error mid-flow. The runner
	// switches to the llm_error_mid_flow failure mode and ships a
	// degraded-path DM with whatever drafts were already saved.
	llm_error?: string;
}

export type LlmTurnCaller = (req: LlmTurnRequest) => Promise<LlmTurnResult>;

export interface SlackDmSender {
	sendBlocks(userId: string, fallback_text: string, blocks: SlackBlock[]): Promise<string | null>;
}

export interface DraftSink {
	persistLocal(args: {
		fire_id: string;
		persona_id: string;
		drafts: LlmTurnRawDraft[];
	}): Promise<{ draft_id: string; kind: DraftKind; summary: string }[]>;
	postToControl?: (args: {
		fire_id: string;
		persona_id: string;
		tenant_slug: string;
		drafts: { draft_id: string; kind: DraftKind; summary: string; body: string; reference_url?: string }[];
	}) => Promise<void>;
}

export interface FirstHourLedgerSink {
	read(): { completed_at: string | null; started_at: string | null };
	markStarted(fire_id: string): void;
	markCompleted(reason_code: ReasonCode): void;
}

export type AuditEmit = (event: AuditEvent) => void;

export interface RunFirstHourDeps {
	llm: LlmTurnCaller;
	slack: SlackDmSender;
	drafts: DraftSink;
	ledger: FirstHourLedgerSink;
	audit: AuditEmit;
	owner_user_id: string;
	dashboard_url?: string;
	agent_id?: string;
	// hard_cap_ms_override: tests inject a small budget (e.g. 200ms) to
	// exercise the sixty_second_cap_hit path. Production passes
	// undefined to use the persona's catalog ttd_hard_cap_seconds * 1000.
	hard_cap_ms_override?: number;
	now?: () => Date;
	// available_integrations_override: tests skip the env reader by
	// passing the set explicitly. Production omits this and the runner
	// reads PHANTOM_GRANTED_INTEGRATIONS.
	available_integrations_override?: readonly string[];
}

export async function runFirstHourOfWorkOnFirstboot(
	input: Omit<FirstHourOfWorkInput, "available_integrations">,
	deps: RunFirstHourDeps,
): Promise<FirstHourOfWorkOutput> {
	const startedAt = (deps.now ?? (() => new Date()))();
	const startMs = startedAt.getTime();
	const fireId = input.fire_id;

	// Layer 1 idempotency: in-VM SQLite ledger. If completed_at is set,
	// silently skip; the dashboard surfaces the prior state. The audit
	// sink does NOT receive a re-fire event.
	const ledgerRow = deps.ledger.read();
	if (ledgerRow.completed_at) {
		return makeOutput({
			ok: false,
			startMs,
			now: deps.now,
			reason_code: "fire_already_completed",
		});
	}

	const persona = getPersonaWorkPlan(input.persona_id);
	if (!persona) {
		// persona_unknown: no DM (we have no voice to use), audit + skip.
		emitAudit(deps.audit, "first_hour_of_work_finish", {
			tenant_slug: input.tenant_slug,
			persona_id: input.persona_id,
			fire_id: fireId,
			payload: { reason_code: "persona_unknown", success: false, duration_seconds: 0 },
		});
		return makeOutput({
			ok: false,
			startMs,
			now: deps.now,
			reason_code: "persona_unknown",
		});
	}

	// Available integrations: prefer the deps override (tests), fall
	// back to PHANTOM_GRANTED_INTEGRATIONS (production).
	const grants = deps.available_integrations_override
		? Array.from(deps.available_integrations_override)
		: readGrantedIntegrations();
	const intersection = filterIntegrationsByGrants(persona.required_integrations, grants);

	emitAudit(deps.audit, "first_hour_of_work_start", {
		tenant_slug: input.tenant_slug,
		persona_id: persona.persona_id,
		fire_id: fireId,
		payload: {
			owner_user_id: deps.owner_user_id,
			available_integrations: grants,
		},
	});

	// Mark started (layer 1 ledger transition into in-flight).
	deps.ledger.markStarted(fireId);

	// no_integrations_granted: a persona with required_integrations that
	// have NO intersection with the resolved grant set. The runner
	// short-circuits to the fallback DM; no LLM call is made.
	if (persona.required_integrations.length > 0 && intersection.length === 0) {
		const dmTextBody = persona.fallback_dm_text;
		const blocks = renderFirstHourDmFallbackBlocks({
			persona,
			body: dmTextBody,
			dashboard_url: deps.dashboard_url,
		});
		const fallbackText = `${persona.intro_line} ${dmTextBody}`;
		const messageTs = await deps.slack.sendBlocks(deps.owner_user_id, fallbackText, blocks);
		const reason: ReasonCode = messageTs ? "no_integrations_granted" : "slack_post_failed";
		if (messageTs) {
			emitAudit(deps.audit, "first_hour_of_work_dm", {
				tenant_slug: input.tenant_slug,
				persona_id: persona.persona_id,
				fire_id: fireId,
				payload: { message_id: messageTs, draft_count: 0 },
			});
		}
		const out = makeOutput({
			ok: false,
			startMs,
			now: deps.now,
			reason_code: reason,
			dm_message_id: messageTs,
		});
		deps.ledger.markCompleted(reason);
		emitAudit(deps.audit, "first_hour_of_work_finish", {
			tenant_slug: input.tenant_slug,
			persona_id: persona.persona_id,
			fire_id: fireId,
			payload: {
				reason_code: reason,
				success: false,
				duration_seconds: out.duration_seconds,
			},
		});
		return out;
	}

	// Build the scaffold prompt. The LLM caller handles the model
	// dispatch; this runner just hands over the prompt + the grant set
	// and waits for the parsed envelope (or a timeout / error).
	const ownerName = input.owner_name?.trim() || input.owner_email.split("@")[0] || "there";
	const prompt = buildScaffoldPrompt({
		persona,
		owner_name: ownerName,
		owner_user_id: deps.owner_user_id,
		available_integrations: grants,
		persona_subtitle: resolvePersonaSubtitle(persona.persona_id),
	});

	const hardCapMs = deps.hard_cap_ms_override ?? persona.ttd_hard_cap_seconds * 1000;
	const controller = new AbortController();
	let capHit = false;
	const capTimer = setTimeout(() => {
		capHit = true;
		controller.abort();
	}, hardCapMs);

	let llmResult: LlmTurnResult | null = null;
	let llmError: Error | null = null;
	try {
		llmResult = await deps.llm({
			prompt,
			persona,
			available_integrations: grants,
			signal: controller.signal,
		});
	} catch (err) {
		llmError = err instanceof Error ? err : new Error(String(err));
	} finally {
		clearTimeout(capTimer);
	}

	// Determine the reason code from what the LLM returned.
	let reason: ReasonCode = "ok";
	let savedDrafts: LlmTurnRawDraft[] = [];
	let pulls: PullExecuted[] = [];
	let expiredProvider: string | undefined;

	if (capHit) {
		reason = "sixty_second_cap_hit";
		savedDrafts = llmResult?.saved_drafts ?? [];
		pulls = llmResult?.pulls_executed ?? [];
	} else if (llmError) {
		reason = "llm_error_mid_flow";
		savedDrafts = llmResult?.saved_drafts ?? [];
		pulls = llmResult?.pulls_executed ?? [];
	} else if (llmResult?.llm_error) {
		reason = "llm_error_mid_flow";
		savedDrafts = llmResult.saved_drafts;
		pulls = llmResult.pulls_executed;
	} else if (llmResult?.expired_provider) {
		reason = "integration_auth_expired";
		expiredProvider = llmResult.expired_provider;
		savedDrafts = llmResult.saved_drafts;
		pulls = llmResult.pulls_executed;
	} else if (llmResult) {
		savedDrafts = llmResult.saved_drafts;
		pulls = llmResult.pulls_executed;
		const totalRows = pulls.reduce((sum, p) => sum + p.rows, 0);
		if (savedDrafts.length === 0) {
			if (totalRows === 0) {
				reason = "all_pulls_zero_data";
			} else {
				reason = "zero_drafts_from_nonzero_data";
			}
		}
	} else {
		reason = "internal_error";
	}

	// Pull events: one audit row per pull, with the source/query/rows/
	// error_kind exactly as the LLM caller surfaced.
	for (const pull of pulls) {
		emitAudit(deps.audit, "first_hour_of_work_pulls", {
			tenant_slug: input.tenant_slug,
			persona_id: persona.persona_id,
			fire_id: fireId,
			payload: {
				source: pull.source,
				query: pull.query,
				rows: pull.rows,
				error_kind: pull.error_kind,
			},
		});
	}

	// Persist drafts (architect §4.1: local SQLite + best-effort POST to
	// phantom-control). The persistLocal step assigns draft_ids; the
	// post-to-control step is no-op in dev and a real mTLS POST in
	// production (slice 15b will land the endpoint).
	const persistedDrafts: {
		draft_id: string;
		kind: DraftKind;
		summary: string;
		body: string;
		reference_url?: string;
	}[] = [];
	if (savedDrafts.length > 0) {
		const persisted = await deps.drafts.persistLocal({
			fire_id: fireId,
			persona_id: persona.persona_id,
			drafts: savedDrafts,
		});
		for (let i = 0; i < persisted.length; i++) {
			const p = persisted[i];
			const raw = savedDrafts[i];
			persistedDrafts.push({
				draft_id: p.draft_id,
				kind: p.kind,
				summary: p.summary,
				body: raw.body,
				reference_url: raw.reference_url,
			});
			emitAudit(deps.audit, "first_hour_of_work_drafts", {
				tenant_slug: input.tenant_slug,
				persona_id: persona.persona_id,
				fire_id: fireId,
				payload: { draft_id: p.draft_id, kind: p.kind },
			});
		}
		if (deps.drafts.postToControl) {
			try {
				await deps.drafts.postToControl({
					fire_id: fireId,
					persona_id: persona.persona_id,
					tenant_slug: input.tenant_slug,
					drafts: persistedDrafts,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[first-hour] phantom-control draft post failed: ${msg}`);
			}
		}
	}

	// Compose + send the DM.
	let dmMessageId: string | null = null;
	const durationSeconds = computeDurationSeconds(startMs, deps.now);
	if (reason === "ok" || reason === "sixty_second_cap_hit" || reason === "llm_error_mid_flow") {
		// Drafts-bearing path: render the standard DM with the drafts list.
		// On cap-hit / llm-error-with-some-drafts the renderer prepends a
		// partial affordance; on cap-hit / llm-error-with-no-drafts we
		// fall through to the fallback renderer.
		if (persistedDrafts.length > 0) {
			const dmDrafts: FirstHourDmDraft[] = persistedDrafts.map((d) => ({
				draft_id: d.draft_id,
				kind: d.kind,
				summary: d.summary,
				body_preview: truncatePreview(d.body, 320),
				reference_url: d.reference_url,
			}));
			const blocks = renderFirstHourDmBlocks({
				persona,
				drafts: dmDrafts,
				pull_summary: composePullSummary(pulls, persistedDrafts.length),
				duration_seconds: Math.round(durationSeconds),
				dashboard_url: deps.dashboard_url,
				agent_id: deps.agent_id,
				partial: reason !== "ok",
			});
			const fallbackText = renderFirstHourDmFallbackText(persona, persistedDrafts.length);
			dmMessageId = await deps.slack.sendBlocks(deps.owner_user_id, fallbackText, blocks);
		} else {
			// llm_error_mid_flow with zero drafts saved: shipt a single-
			// section "I ran into an issue starting your first hour" DM.
			const dmTextBody =
				dmTextForReason(reason, {
					persona,
					drafts_saved_so_far: 0,
					expired_provider: expiredProvider,
				}) ?? `${persona.intro_line} I ran into an issue starting your first hour. Reply RETRY and I will try again.`;
			const blocks = renderFirstHourDmFallbackBlocks({
				persona,
				body: dmTextBody,
				dashboard_url: deps.dashboard_url,
			});
			dmMessageId = await deps.slack.sendBlocks(deps.owner_user_id, dmTextBody, blocks);
		}
	} else if (
		reason === "all_pulls_zero_data" ||
		reason === "zero_drafts_from_nonzero_data" ||
		reason === "integration_auth_expired"
	) {
		const dmTextBody =
			dmTextForReason(reason, {
				persona,
				drafts_saved_so_far: persistedDrafts.length,
				expired_provider: expiredProvider,
			}) ?? persona.fallback_dm_text;
		const blocks = renderFirstHourDmFallbackBlocks({
			persona,
			body: dmTextBody,
			dashboard_url: deps.dashboard_url,
		});
		dmMessageId = await deps.slack.sendBlocks(deps.owner_user_id, dmTextBody, blocks);
	} else if (reason === "internal_error") {
		// internal_error: no DM (the operator is paged via audit). Future
		// work might surface a sympathetic DM but v1 keeps the user-facing
		// surface clean for the cases the architect explicitly designed.
	}

	// Slack post failure: switch reason to slack_post_failed if the DM
	// path was taken but Slack returned null. Drafts persist; the
	// dashboard surfaces them.
	if (dmMessageId === null && reason !== "internal_error") {
		reason = "slack_post_failed";
	} else if (dmMessageId !== null) {
		emitAudit(deps.audit, "first_hour_of_work_dm", {
			tenant_slug: input.tenant_slug,
			persona_id: persona.persona_id,
			fire_id: fireId,
			payload: { message_id: dmMessageId, draft_count: persistedDrafts.length },
		});
	}

	const finishDuration = computeDurationSeconds(startMs, deps.now);
	emitAudit(deps.audit, "first_hour_of_work_finish", {
		tenant_slug: input.tenant_slug,
		persona_id: persona.persona_id,
		fire_id: fireId,
		payload: {
			reason_code: reason,
			success: reason === "ok",
			duration_seconds: finishDuration,
		},
	});

	deps.ledger.markCompleted(reason);

	return {
		ok: reason === "ok",
		drafts_created: persistedDrafts.length,
		dm_message_id: dmMessageId,
		duration_seconds: finishDuration,
		pulls_executed: pulls,
		drafts: persistedDrafts.map((d) => ({
			draft_id: d.draft_id,
			kind: d.kind,
			summary: d.summary,
		})),
		reason_code: reason,
	};
}

function emitAudit(
	emit: AuditEmit,
	kind: AuditEventKind,
	args: { tenant_slug: string; persona_id: string; fire_id: string; payload: Record<string, unknown> },
): void {
	emit({
		kind,
		tenant_slug: args.tenant_slug,
		persona_id: args.persona_id,
		fire_id: args.fire_id,
		ts: new Date().toISOString(),
		payload: args.payload,
	});
}

function makeOutput(args: {
	ok: boolean;
	startMs: number;
	now?: () => Date;
	reason_code: ReasonCode;
	dm_message_id?: string | null;
}): FirstHourOfWorkOutput {
	return {
		ok: args.ok,
		drafts_created: 0,
		dm_message_id: args.dm_message_id ?? null,
		duration_seconds: computeDurationSeconds(args.startMs, args.now),
		pulls_executed: [],
		drafts: [],
		reason_code: args.reason_code,
	};
}

function computeDurationSeconds(startMs: number, now?: () => Date): number {
	const nowMs = (now ?? (() => new Date()))().getTime();
	const seconds = Math.max(0, (nowMs - startMs) / 1000);
	return Math.round(seconds * 1000) / 1000;
}

function composePullSummary(pulls: PullExecuted[], draft_count: number): string {
	if (pulls.length === 0) {
		return draft_count > 0 ? `Drafted *${draft_count} items*.` : "No pulls executed.";
	}
	const totalRows = pulls.reduce((sum, p) => sum + p.rows, 0);
	const sourceList = uniqueSources(pulls).join(", ");
	const items = draft_count === 1 ? "1 item" : `${draft_count} items`;
	return `I pulled *${totalRows} rows* across ${sourceList}. Drafted *${items}*.`;
}

function uniqueSources(pulls: PullExecuted[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of pulls) {
		if (seen.has(p.source)) continue;
		seen.add(p.source);
		out.push(p.source);
	}
	return out;
}

function truncatePreview(body: string, max: number): string {
	const oneLine = body.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, Math.max(0, max - 3))}...`;
}
