// Audit log for skill edits. Every create/update/delete from the UI API writes
// a row here so the user can see the history of their skills. The agent's own
// Write tool edits bypass this path today; if we want to catch those we'll add
// a file watcher in a later PR.

import type { Database } from "bun:sqlite";

export type SkillAuditAction = "create" | "update" | "delete";

export type SkillAuditEntry = {
	id: number;
	skill_name: string;
	action: SkillAuditAction;
	previous_body: string | null;
	new_body: string | null;
	actor: string;
	created_at: string;
};

export function recordSkillEdit(
	db: Database,
	params: {
		name: string;
		action: SkillAuditAction;
		previousBody: string | null;
		newBody: string | null;
		actor: string;
	},
): void {
	db.run(
		`INSERT INTO skill_audit_log (skill_name, action, previous_body, new_body, actor)
		 VALUES (?, ?, ?, ?, ?)`,
		[params.name, params.action, params.previousBody, params.newBody, params.actor],
	);
}

export function listSkillEdits(db: Database, skillName?: string, limit = 50): SkillAuditEntry[] {
	if (skillName) {
		return db
			.query(
				`SELECT id, skill_name, action, previous_body, new_body, actor, created_at
				 FROM skill_audit_log
				 WHERE skill_name = ?
				 ORDER BY id DESC
				 LIMIT ?`,
			)
			.all(skillName, limit) as SkillAuditEntry[];
	}
	return db
		.query(
			`SELECT id, skill_name, action, previous_body, new_body, actor, created_at
			 FROM skill_audit_log
			 ORDER BY id DESC
			 LIMIT ?`,
		)
		.all(limit) as SkillAuditEntry[];
}
