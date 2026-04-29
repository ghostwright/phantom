// Audit log for memory file edits. Same pattern as skills/audit.ts.

import type { Database } from "bun:sqlite";

export type MemoryFileAuditAction = "create" | "update" | "delete";

export type MemoryFileAuditEntry = {
	id: number;
	file_path: string;
	action: MemoryFileAuditAction;
	previous_content: string | null;
	new_content: string | null;
	actor: string;
	created_at: string;
};

export function recordMemoryFileEdit(
	db: Database,
	params: {
		path: string;
		action: MemoryFileAuditAction;
		previousContent: string | null;
		newContent: string | null;
		actor: string;
	},
): void {
	db.run(
		`INSERT INTO memory_file_audit_log (file_path, action, previous_content, new_content, actor)
		 VALUES (?, ?, ?, ?, ?)`,
		[params.path, params.action, params.previousContent, params.newContent, params.actor],
	);
}

export function listMemoryFileEdits(db: Database, filePath?: string, limit = 50): MemoryFileAuditEntry[] {
	if (filePath) {
		return db
			.query(
				`SELECT id, file_path, action, previous_content, new_content, actor, created_at
				 FROM memory_file_audit_log
				 WHERE file_path = ?
				 ORDER BY id DESC
				 LIMIT ?`,
			)
			.all(filePath, limit) as MemoryFileAuditEntry[];
	}
	return db
		.query(
			`SELECT id, file_path, action, previous_content, new_content, actor, created_at
			 FROM memory_file_audit_log
			 ORDER BY id DESC
			 LIMIT ?`,
		)
		.all(limit) as MemoryFileAuditEntry[];
}
