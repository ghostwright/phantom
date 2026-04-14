// Audit log for hook installs, updates, uninstalls, and relocates via the
// UI API. Each row captures the full previous and new hooks slice as JSON
// so a human can diff and recover. Agent-originated edits via the Write
// tool bypass this path.
//
// Trust acceptance is scoped per hook type. Before the fix, accepting
// trust for a command hook also satisfied the prompt, that `http` and
// `agent` hook types never re-fired the trust modal, which is surprising
// given their very different risk profiles (http means network egress).
// The fix stores the hook type alongside the trust_accepted action and
// checks against the type on read.

import type { Database } from "bun:sqlite";
import type { HookDefinition, HookEvent, HooksSlice } from "./schema.ts";

export type HookAuditAction = "install" | "update" | "uninstall" | "relocate" | "trust_accepted";

export type HookAuditEntry = {
	id: number;
	event: string;
	matcher: string | null;
	hook_type: string | null;
	action: HookAuditAction;
	previous_slice: string | null;
	new_slice: string | null;
	definition_json: string | null;
	actor: string;
	created_at: string;
};

export function recordHookEdit(
	db: Database,
	params: {
		event: HookEvent | "<trust>";
		matcher: string | undefined;
		hookType: HookDefinition["type"] | null;
		action: HookAuditAction;
		previousSlice: HooksSlice | null;
		newSlice: HooksSlice | null;
		definition: HookDefinition | null;
		actor: string;
	},
): void {
	db.run(
		`INSERT INTO hook_audit_log (event, matcher, hook_type, action, previous_slice, new_slice, definition_json, actor)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			params.event,
			params.matcher ?? null,
			params.hookType,
			params.action,
			params.previousSlice ? JSON.stringify(params.previousSlice) : null,
			params.newSlice ? JSON.stringify(params.newSlice) : null,
			params.definition ? JSON.stringify(params.definition) : null,
			params.actor,
		],
	);
}

export function listHookAudit(db: Database, limit = 50): HookAuditEntry[] {
	return db
		.query(
			`SELECT id, event, matcher, hook_type, action, previous_slice, new_slice, definition_json, actor, created_at
			 FROM hook_audit_log
			 ORDER BY id DESC
			 LIMIT ?`,
		)
		.all(limit) as HookAuditEntry[];
}

// Returns true if the operator has accepted the trust modal for this
// specific hook type. Scoping trust per type keeps the backstop alive
// when a user who consented to command hooks installs their first http
// hook: the modal fires again because http has a different risk
// profile. A null type argument asks "any trust at all" and is used by
// the legacy codepath.
export function hasAcceptedHookTrust(db: Database, hookType?: HookDefinition["type"]): boolean {
	if (hookType) {
		const row = db
			.query("SELECT COUNT(*) as count FROM hook_audit_log WHERE action = 'trust_accepted' AND hook_type = ?")
			.get(hookType) as { count: number } | null;
		return (row?.count ?? 0) > 0;
	}
	const row = db.query("SELECT COUNT(*) as count FROM hook_audit_log WHERE action = 'trust_accepted'").get() as {
		count: number;
	} | null;
	return (row?.count ?? 0) > 0;
}

// Returns a record of hookType -> accepted boolean so the dashboard can
// preload the trust state for every type in one request. Used by the
// listHooks API to avoid a second round trip just to render the trust
// modal.
export function getHookTrustMap(db: Database): Record<string, boolean> {
	const rows = db
		.query("SELECT DISTINCT hook_type FROM hook_audit_log WHERE action = 'trust_accepted' AND hook_type IS NOT NULL")
		.all() as Array<{ hook_type: string | null }>;
	const out: Record<string, boolean> = { command: false, prompt: false, agent: false, http: false };
	for (const row of rows) {
		if (row.hook_type) out[row.hook_type] = true;
	}
	return out;
}
