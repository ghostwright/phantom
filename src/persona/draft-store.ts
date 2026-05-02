// Local SQLite draft store for do_first_hour_of_work (architect §4.1
// "phantom_drafts" plus §3.4 firstboot ledger). The runner persists
// each draft here before POSTing to phantom-control (slice 15b); the
// action handler reads back by draft_id when the user clicks
// Send/Edit/Skip on the Slack DM.
//
// Schema lives in src/db/schema.ts:
//   firstboot_state.first_hour_of_work_{started_at,completed_at,reason_code,fire_id}
//   phantom_drafts (draft_id PK, fire_id, persona_id, kind, summary, body, ...)

import type { Database } from "bun:sqlite";
import type { PersistedDraft, ReasonCode } from "./types.ts";

export interface FirstHourLedgerRow {
	first_hour_of_work_started_at: string | null;
	first_hour_of_work_completed_at: string | null;
	first_hour_of_work_reason_code: string | null;
	first_hour_of_work_fire_id: string | null;
}

export function readFirstHourLedger(db: Database): FirstHourLedgerRow {
	const row = db
		.query<FirstHourLedgerRow, []>(
			`SELECT first_hour_of_work_started_at, first_hour_of_work_completed_at,
				first_hour_of_work_reason_code, first_hour_of_work_fire_id
			FROM firstboot_state WHERE id = 1`,
		)
		.get();
	if (!row) {
		return {
			first_hour_of_work_started_at: null,
			first_hour_of_work_completed_at: null,
			first_hour_of_work_reason_code: null,
			first_hour_of_work_fire_id: null,
		};
	}
	return row;
}

export function markFirstHourStarted(db: Database, fireId: string): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO firstboot_state (id, first_hour_of_work_started_at, first_hour_of_work_fire_id)
		VALUES (1, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			first_hour_of_work_started_at = excluded.first_hour_of_work_started_at,
			first_hour_of_work_fire_id = excluded.first_hour_of_work_fire_id`,
		[now, fireId],
	);
}

export function markFirstHourCompleted(db: Database, reasonCode: ReasonCode): void {
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO firstboot_state (id, first_hour_of_work_completed_at, first_hour_of_work_reason_code)
		VALUES (1, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			first_hour_of_work_completed_at = excluded.first_hour_of_work_completed_at,
			first_hour_of_work_reason_code = excluded.first_hour_of_work_reason_code`,
		[now, reasonCode],
	);
}

export function persistDraft(db: Database, draft: PersistedDraft): void {
	db.run(
		`INSERT INTO phantom_drafts (
			draft_id, fire_id, persona_id, kind, summary, body, reference_url,
			edit_hints, status, slack_message_ts, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(draft_id) DO UPDATE SET
			body = excluded.body,
			summary = excluded.summary,
			edit_hints = excluded.edit_hints,
			updated_at = excluded.updated_at`,
		[
			draft.draft_id,
			draft.fire_id,
			draft.persona_id,
			draft.kind,
			draft.summary,
			draft.body,
			draft.reference_url ?? null,
			draft.edit_hints ?? null,
			draft.status,
			draft.slack_message_ts ?? null,
			draft.created_at,
			draft.updated_at,
		],
	);
}

export function listDraftsForFire(db: Database, fireId: string): PersistedDraft[] {
	return db
		.query<PersistedDraft, [string]>(
			`SELECT draft_id, fire_id, persona_id, kind, summary, body, reference_url,
				edit_hints, status, slack_message_ts, created_at, updated_at
			FROM phantom_drafts WHERE fire_id = ? ORDER BY created_at`,
		)
		.all(fireId);
}

export function getDraftById(db: Database, draftId: string): PersistedDraft | null {
	const row = db
		.query<PersistedDraft, [string]>(
			`SELECT draft_id, fire_id, persona_id, kind, summary, body, reference_url,
				edit_hints, status, slack_message_ts, created_at, updated_at
			FROM phantom_drafts WHERE draft_id = ?`,
		)
		.get(draftId);
	return row ?? null;
}
