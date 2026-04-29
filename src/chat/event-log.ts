import type { Database } from "bun:sqlite";

export type ChatStreamEvent = {
	id: number;
	session_id: string;
	message_id: string | null;
	seq: number;
	event_type: string;
	payload_json: string;
	created_at: string;
};

export class ChatEventLog {
	private db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	append(sessionId: string, messageId: string | null, seq: number, eventType: string, payload: unknown): void {
		this.db.run(
			`INSERT INTO chat_stream_events (session_id, message_id, seq, event_type, payload_json)
			 VALUES (?, ?, ?, ?, ?)`,
			[sessionId, messageId, seq, eventType, JSON.stringify(payload)],
		);
	}

	drain(sessionId: string, afterSeq: number, limit?: number): ChatStreamEvent[] {
		const maxRows = limit ?? 5000;
		return this.db
			.query(
				`SELECT * FROM chat_stream_events
				 WHERE session_id = ? AND seq > ?
				 ORDER BY seq ASC
				 LIMIT ?`,
			)
			.all(sessionId, afterSeq, maxRows) as ChatStreamEvent[];
	}

	getMaxSeq(sessionId: string): number {
		const row = this.db
			.query("SELECT MAX(seq) as max_seq FROM chat_stream_events WHERE session_id = ?")
			.get(sessionId) as { max_seq: number | null } | null;
		return row?.max_seq ?? 0;
	}

	sweep(olderThanHours: number): number {
		const result = this.db.run(
			`DELETE FROM chat_stream_events
			 WHERE created_at < datetime('now', ?)`,
			[`-${olderThanHours} hours`],
		);
		return result.changes;
	}

	deleteBySession(sessionId: string): number {
		const result = this.db.run("DELETE FROM chat_stream_events WHERE session_id = ?", [sessionId]);
		return result.changes;
	}
}
