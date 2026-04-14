// Audit log for subagent edits. Every create/update/delete from the UI API
// writes a row here so the user can see the history of their subagents.
// Agent-originated edits via the Write tool bypass this path; a future PR may
// add a file watcher to capture those.

import type { Database } from "bun:sqlite";

export type SubagentAuditAction = "create" | "update" | "delete";

export type SubagentAuditEntry = {
	id: number;
	subagent_name: string;
	action: SubagentAuditAction;
	previous_body: string | null;
	new_body: string | null;
	actor: string;
	created_at: string;
};

export function recordSubagentEdit(
	db: Database,
	params: {
		name: string;
		action: SubagentAuditAction;
		previousBody: string | null;
		newBody: string | null;
		actor: string;
	},
): void {
	db.run(
		`INSERT INTO subagent_audit_log (subagent_name, action, previous_body, new_body, actor)
		 VALUES (?, ?, ?, ?, ?)`,
		[params.name, params.action, params.previousBody, params.newBody, params.actor],
	);
}

export function listSubagentEdits(db: Database, subagentName?: string, limit = 50): SubagentAuditEntry[] {
	if (subagentName) {
		return db
			.query(
				`SELECT id, subagent_name, action, previous_body, new_body, actor, created_at
				 FROM subagent_audit_log
				 WHERE subagent_name = ?
				 ORDER BY id DESC
				 LIMIT ?`,
			)
			.all(subagentName, limit) as SubagentAuditEntry[];
	}
	return db
		.query(
			`SELECT id, subagent_name, action, previous_body, new_body, actor, created_at
			 FROM subagent_audit_log
			 ORDER BY id DESC
			 LIMIT ?`,
		)
		.all(limit) as SubagentAuditEntry[];
}
