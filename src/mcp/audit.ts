import type { Database } from "bun:sqlite";
import { truncate } from "../shared/strings.ts";
import type { AuditEntry } from "./types.ts";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS mcp_audit (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	timestamp TEXT NOT NULL DEFAULT (datetime('now')),
	client_name TEXT NOT NULL,
	method TEXT NOT NULL,
	tool_name TEXT,
	resource_uri TEXT,
	input_summary TEXT,
	output_summary TEXT,
	cost_usd REAL DEFAULT 0,
	duration_ms INTEGER DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'success'
)`;

export class AuditLogger {
	private db: Database;
	private insertStmt: ReturnType<Database["prepare"]>;

	constructor(db: Database) {
		this.db = db;
		this.db.run(CREATE_TABLE);
		this.insertStmt = this.db.prepare(
			`INSERT INTO mcp_audit (client_name, method, tool_name, resource_uri, input_summary, output_summary, cost_usd, duration_ms, status)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
	}

	log(entry: Omit<AuditEntry, "id" | "timestamp">): void {
		try {
			this.insertStmt.run(
				entry.client_name,
				entry.method,
				entry.tool_name,
				entry.resource_uri,
				entry.input_summary ? truncate(entry.input_summary, 500) : null,
				entry.output_summary ? truncate(entry.output_summary, 500) : null,
				entry.cost_usd,
				entry.duration_ms,
				entry.status,
			);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[mcp-audit] Failed to log: ${msg}`);
		}
	}

	getRecent(limit = 50): AuditEntry[] {
		return this.db.query("SELECT * FROM mcp_audit ORDER BY id DESC LIMIT ?").all(limit) as AuditEntry[];
	}

	getByClient(clientName: string, limit = 50): AuditEntry[] {
		return this.db
			.query("SELECT * FROM mcp_audit WHERE client_name = ? ORDER BY id DESC LIMIT ?")
			.all(clientName, limit) as AuditEntry[];
	}
}
