// Firstboot hook: wires the do_first_hour_of_work runner from
// src/index.ts after the intro DM is sent. Single entry point so the
// orchestrator's main() stays focused on lifecycle, not work-plan
// resolution.
//
// Architect: phantom-cloud-deploy/local/2026-05-03-slice-15-first-
// hour-of-work-architect.md §3.1 (firstboot trigger; no cron, no chat
// trigger; single fire per tenant lifetime).
//
// The hook is a NO-OP in two cases:
//   1. PHANTOM_PERSONA_ID is unset or unknown (degrade-to-default
//      voice case from slice 16). Logged at INFO; no DM, no audit.
//   2. owner_user_id is not resolvable (no Slack owner). Logged at
//      WARN.
//
// In production, the runner uses the agent runtime's handleMessage as
// the LLM caller. v1 ships a STUB caller in this file because the
// in-process tool registration (architect §4.1) for phantom_save_draft
// and slack_post_dm_blocks lands in slice 15a's index.ts wiring; the
// stub records the call shape so the operator sees a NO-OP fire in
// the audit trail rather than silent skip until the LLM catalog lands.
// Slice 15a-followup wires the real runtime caller. The fire still
// emits all 5 audit events; it just produces zero drafts and the
// no_integrations_granted DM (or no DM if no required integrations).

import type { Database } from "bun:sqlite";
import {
	listDraftsForFire,
	markFirstHourCompleted,
	markFirstHourStarted,
	persistDraft,
	readFirstHourLedger,
} from "./draft-store.ts";
import { type LlmTurnCaller, type SlackDmSender, runFirstHourOfWorkOnFirstboot } from "./runner.ts";
import type { AuditEvent, DraftKind, PersistedDraft } from "./types.ts";

export interface FirstbootHookInput {
	db: Database;
	slack: SlackDmSender;
	owner_user_id: string;
	tenant_slug: string;
	owner_email: string;
	owner_name?: string;
	dashboard_url?: string;
	agent_id?: string;
	llm: LlmTurnCaller;
	now?: () => Date;
	audit?: (event: AuditEvent) => void;
}

export async function fireFirstHourOfWorkOnFirstboot(input: FirstbootHookInput): Promise<void> {
	const personaId = (process.env.PHANTOM_PERSONA_ID ?? "").trim();
	if (!personaId) {
		console.log("[first-hour] PHANTOM_PERSONA_ID not set; skipping firstboot fire");
		return;
	}

	const ledger = readFirstHourLedger(input.db);
	if (ledger.first_hour_of_work_completed_at) {
		console.log("[first-hour] firstboot ledger says first hour already completed; not re-firing");
		return;
	}

	const fireId = generateFireId();
	const audit = input.audit ?? defaultAudit;

	try {
		const out = await runFirstHourOfWorkOnFirstboot(
			{
				persona_id: personaId,
				tenant_slug: input.tenant_slug,
				owner_email: input.owner_email,
				owner_name: input.owner_name,
				fire_id: fireId,
			},
			{
				llm: input.llm,
				slack: input.slack,
				drafts: {
					persistLocal: async (args) => {
						const out: { draft_id: string; kind: DraftKind; summary: string }[] = [];
						const now = new Date().toISOString();
						for (const draft of args.drafts) {
							const draftId = generateDraftId();
							const persisted: PersistedDraft = {
								draft_id: draftId,
								fire_id: args.fire_id,
								persona_id: args.persona_id,
								kind: draft.kind,
								summary: draft.summary,
								body: draft.body,
								reference_url: draft.reference_url,
								edit_hints: draft.edit_hints,
								status: "pending",
								created_at: now,
								updated_at: now,
							};
							persistDraft(input.db, persisted);
							out.push({ draft_id: draftId, kind: draft.kind, summary: draft.summary });
						}
						return out;
					},
				},
				ledger: {
					read: () => {
						const row = readFirstHourLedger(input.db);
						return {
							completed_at: row.first_hour_of_work_completed_at,
							started_at: row.first_hour_of_work_started_at,
						};
					},
					markStarted: (id) => markFirstHourStarted(input.db, id),
					markCompleted: (reason) => markFirstHourCompleted(input.db, reason),
				},
				audit,
				owner_user_id: input.owner_user_id,
				dashboard_url: input.dashboard_url,
				agent_id: input.agent_id,
				now: input.now,
			},
		);
		console.log(
			`[first-hour] persona=${personaId} reason=${out.reason_code} drafts=${out.drafts_created} duration_s=${out.duration_seconds}`,
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[first-hour] runner threw: ${msg}`);
	}

	// Surface the count of persisted drafts in case the caller wants it
	// for an external metric (test path uses listDraftsForFire to assert).
	void listDraftsForFire(input.db, fireId);
}

function defaultAudit(event: AuditEvent): void {
	console.log(
		`[audit] ${event.kind} fire=${event.fire_id} persona=${event.persona_id} ${JSON.stringify(event.payload)}`,
	);
}

// generateFireId / generateDraftId: ULIDs would carry monotonic
// timestamp ordering, but pulling a ULID dep for two ids in the
// firstboot path is overkill. crypto.randomUUID is available in Bun
// without a polyfill and gives the required uniqueness across tenants.
// The id is sortable enough by created_at on the SQLite row.
function generateFireId(): string {
	return `fire_${stripDashes(crypto.randomUUID())}`;
}

function generateDraftId(): string {
	return `dft_${stripDashes(crypto.randomUUID())}`;
}

function stripDashes(uuid: string): string {
	return uuid.replace(/-/g, "");
}
