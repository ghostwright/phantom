// Audit log for subagent edits. Every create/update/delete from the UI API
// writes a row here so the user can see the history of their subagents.
// Agent-originated edits via the Write tool bypass this path; a future PR may
// add a file watcher to capture those.
//
// The row captures both the body and the frontmatter JSON so an edit that
// changes only the tools allowlist or the model is visible in the timeline.
// Before the PR3 fix pass this was body-only, which made frontmatter-only
// edits invisible on the audit panel.

import type { Database } from "bun:sqlite";

export type SubagentAuditAction = "create" | "update" | "delete";

export type SubagentAuditEntry = {
	id: number;
	subagent_name: string;
	action: SubagentAuditAction;
	previous_body: string | null;
	new_body: string | null;
	previous_frontmatter_json: string | null;
	new_frontmatter_json: string | null;
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
		previousFrontmatterJson: string | null;
		newFrontmatterJson: string | null;
		actor: string;
	},
): void {
	db.run(
		`INSERT INTO subagent_audit_log (
			subagent_name, action, previous_body, new_body,
			previous_frontmatter_json, new_frontmatter_json, actor
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			params.name,
			params.action,
			params.previousBody,
			params.newBody,
			params.previousFrontmatterJson,
			params.newFrontmatterJson,
			params.actor,
		],
	);
}

export function listSubagentEdits(db: Database, subagentName?: string, limit = 50): SubagentAuditEntry[] {
	if (subagentName) {
		return db
			.query(
				`SELECT id, subagent_name, action, previous_body, new_body,
				        previous_frontmatter_json, new_frontmatter_json, actor, created_at
				 FROM subagent_audit_log
				 WHERE subagent_name = ?
				 ORDER BY id DESC
				 LIMIT ?`,
			)
			.all(subagentName, limit) as SubagentAuditEntry[];
	}
	return db
		.query(
			`SELECT id, subagent_name, action, previous_body, new_body,
			        previous_frontmatter_json, new_frontmatter_json, actor, created_at
			 FROM subagent_audit_log
			 ORDER BY id DESC
			 LIMIT ?`,
		)
		.all(limit) as SubagentAuditEntry[];
}
