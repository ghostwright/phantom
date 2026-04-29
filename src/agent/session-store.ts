import type { Database } from "bun:sqlite";

export type Session = {
	id: number;
	session_key: string;
	sdk_session_id: string | null;
	channel_id: string;
	conversation_id: string;
	status: string;
	total_cost_usd: number;
	input_tokens: number;
	output_tokens: number;
	turn_count: number;
	created_at: string;
	last_active_at: string;
};

const STALE_HOURS = 24;

export class SessionStore {
	private db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	create(channelId: string, conversationId: string): Session {
		const sessionKey = `${channelId}:${conversationId}`;

		// Upsert: if an expired row with this key exists, reactivate it
		// instead of failing on the UNIQUE constraint.
		this.db.run(
			`INSERT INTO sessions (session_key, channel_id, conversation_id)
			 VALUES (?, ?, ?)
			 ON CONFLICT(session_key) DO UPDATE SET
			   status = 'active',
			   sdk_session_id = NULL,
			   last_active_at = datetime('now')`,
			[sessionKey, channelId, conversationId],
		);

		return this.getByKey(sessionKey) as Session;
	}

	getByKey(sessionKey: string): Session | null {
		return this.db.query("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) as Session | null;
	}

	findActive(channelId: string, conversationId: string): Session | null {
		const sessionKey = `${channelId}:${conversationId}`;
		const session = this.getByKey(sessionKey);

		if (!session) return null;
		if (session.status !== "active") return null;

		if (this.isStale(session)) {
			this.expire(sessionKey);
			return null;
		}

		return session;
	}

	updateSdkSessionId(sessionKey: string, sdkSessionId: string): void {
		this.db.run(
			`UPDATE sessions SET sdk_session_id = ?, last_active_at = datetime('now')
			 WHERE session_key = ?`,
			[sdkSessionId, sessionKey],
		);
	}

	clearSdkSessionId(sessionKey: string): void {
		this.db.run(
			`UPDATE sessions SET sdk_session_id = NULL, last_active_at = datetime('now')
			 WHERE session_key = ?`,
			[sessionKey],
		);
	}

	/**
	 * Clear all SDK session IDs on startup.
	 *
	 * SDK session IDs are process-local and do not survive restarts.
	 * Without this, container recreates leave stale IDs in SQLite
	 * (persisted volume), causing the runtime to attempt impossible
	 * resumes that deadlock the CLI channel.  See #25.
	 */
	clearAllSdkSessionIds(): number {
		const result = this.db.run(
			"UPDATE sessions SET sdk_session_id = NULL WHERE sdk_session_id IS NOT NULL",
		);
		return result.changes;
	}

	touch(sessionKey: string): void {
		this.db.run("UPDATE sessions SET last_active_at = datetime('now') WHERE session_key = ?", [sessionKey]);
	}

	expire(sessionKey: string): void {
		this.db.run("UPDATE sessions SET status = 'expired' WHERE session_key = ?", [sessionKey]);
	}

	private isStale(session: Session): boolean {
		const lastActive = new Date(session.last_active_at).getTime();
		const now = Date.now();
		const hoursElapsed = (now - lastActive) / (1000 * 60 * 60);
		return hoursElapsed > STALE_HOURS;
	}
}
