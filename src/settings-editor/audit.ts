// Audit log for curated settings edits. One row per dirty field per write
// captures the key, the previous value, and the new value as JSON so a
// human can diff and recover. Agent-originated Write tool edits to
// settings.json bypass this path.

import type { Database } from "bun:sqlite";

export type SettingsAuditEntry = {
	id: number;
	field: string;
	previous_value: string | null;
	new_value: string | null;
	actor: string;
	created_at: string;
};

export function recordSettingsEdit(
	db: Database,
	params: {
		field: string;
		previousValue: unknown;
		newValue: unknown;
		actor: string;
	},
): void {
	db.run(
		`INSERT INTO settings_audit_log (field, previous_value, new_value, actor)
		 VALUES (?, ?, ?, ?)`,
		[
			params.field,
			params.previousValue === undefined ? null : JSON.stringify(params.previousValue),
			params.newValue === undefined ? null : JSON.stringify(params.newValue),
			params.actor,
		],
	);
}

export function listSettingsAudit(db: Database, limit = 50): SettingsAuditEntry[] {
	return db
		.query(
			`SELECT id, field, previous_value, new_value, actor, created_at
			 FROM settings_audit_log
			 ORDER BY id DESC
			 LIMIT ?`,
		)
		.all(limit) as SettingsAuditEntry[];
}
