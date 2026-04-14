// Append-only audit log for plugin installs and uninstalls.
//
// Same pattern as src/skills/audit.ts and src/memory-files/audit.ts:
// every create/update/delete from the dashboard API records a row here. The
// agent's own settings.json writes bypass this path today; a future PR may
// add a file watcher to capture those.

import type { Database } from "bun:sqlite";

export type PluginAuditAction = "install" | "uninstall" | "reinstall" | "seed";
export type PluginAuditActor = "user" | "agent" | "seed";

export type PluginAuditEntry = {
	id: number;
	plugin_name: string;
	marketplace: string;
	action: PluginAuditAction;
	source_type: string | null;
	source_url: string | null;
	previous_value: string | null;
	new_value: string | null;
	actor: PluginAuditActor;
	created_at: string;
};

export function recordPluginInstall(
	db: Database,
	params: {
		plugin: string;
		marketplace: string;
		action: PluginAuditAction;
		sourceType: string | null;
		sourceUrl: string | null;
		previousValue: unknown;
		newValue: unknown;
		actor: PluginAuditActor;
	},
): void {
	db.run(
		`INSERT INTO plugin_install_audit_log (plugin_name, marketplace, action, source_type, source_url, previous_value, new_value, actor)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			params.plugin,
			params.marketplace,
			params.action,
			params.sourceType,
			params.sourceUrl,
			params.previousValue === undefined || params.previousValue === null ? null : JSON.stringify(params.previousValue),
			params.newValue === undefined || params.newValue === null ? null : JSON.stringify(params.newValue),
			params.actor,
		],
	);
}

export function listPluginAudit(
	db: Database,
	filter?: { plugin?: string; marketplace?: string; limit?: number },
): PluginAuditEntry[] {
	const limit = filter?.limit ?? 100;
	if (filter?.plugin && filter?.marketplace) {
		return db
			.query(
				`SELECT id, plugin_name, marketplace, action, source_type, source_url, previous_value, new_value, actor, created_at
				 FROM plugin_install_audit_log
				 WHERE plugin_name = ? AND marketplace = ?
				 ORDER BY id DESC
				 LIMIT ?`,
			)
			.all(filter.plugin, filter.marketplace, limit) as PluginAuditEntry[];
	}
	if (filter?.plugin) {
		return db
			.query(
				`SELECT id, plugin_name, marketplace, action, source_type, source_url, previous_value, new_value, actor, created_at
				 FROM plugin_install_audit_log
				 WHERE plugin_name = ?
				 ORDER BY id DESC
				 LIMIT ?`,
			)
			.all(filter.plugin, limit) as PluginAuditEntry[];
	}
	return db
		.query(
			`SELECT id, plugin_name, marketplace, action, source_type, source_url, previous_value, new_value, actor, created_at
			 FROM plugin_install_audit_log
			 ORDER BY id DESC
			 LIMIT ?`,
		)
		.all(limit) as PluginAuditEntry[];
}
