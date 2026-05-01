import type { Database } from "bun:sqlite";
import { CHAT_POST_TERMINAL_NON_RECOVERY_EVENT_TYPES, CHAT_TERMINAL_EVENT_TYPES } from "./sse.ts";

export type ChatStreamEvent = {
	id: number;
	session_id: string;
	message_id: string | null;
	seq: number;
	event_type: string;
	payload_json: string;
	created_at: string;
};

export type ChatStreamState = {
	maxSeq: number;
	latestTerminalSeq: number;
	writerActive: boolean;
	hasIncompleteTail: boolean;
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

	tail(sessionId: string, limit?: number): ChatStreamEvent[] {
		const maxRows = limit ?? 5000;
		const rows = this.db
			.query(
				`SELECT * FROM chat_stream_events
				 WHERE session_id = ?
				 ORDER BY seq DESC
				 LIMIT ?`,
			)
			.all(sessionId, maxRows) as ChatStreamEvent[];
		return rows.reverse();
	}

	getMaxSeq(sessionId: string): number {
		const row = this.db
			.query("SELECT MAX(seq) as max_seq FROM chat_stream_events WHERE session_id = ?")
			.get(sessionId) as { max_seq: number | null } | null;
		return row?.max_seq ?? 0;
	}

	getLatestTerminalSeq(sessionId: string): number {
		const row = this.db
			.query(
				`SELECT MAX(seq) as max_seq FROM chat_stream_events
				 WHERE session_id = ? AND event_type IN (?, ?, ?)`,
			)
			.get(sessionId, ...CHAT_TERMINAL_EVENT_TYPES) as { max_seq: number | null } | null;
		return row?.max_seq ?? 0;
	}

	getLatestRecoveryRelevantSeq(sessionId: string): number {
		const placeholders = CHAT_POST_TERMINAL_NON_RECOVERY_EVENT_TYPES.map(() => "?").join(", ");
		const row = this.db
			.query(
				`SELECT MAX(seq) as max_seq FROM chat_stream_events
				 WHERE session_id = ? AND event_type NOT IN (${placeholders})`,
			)
			.get(sessionId, ...CHAT_POST_TERMINAL_NON_RECOVERY_EVENT_TYPES) as { max_seq: number | null } | null;
		return row?.max_seq ?? 0;
	}

	getStreamState(sessionId: string, writerActive: boolean): ChatStreamState {
		const maxSeq = this.getMaxSeq(sessionId);
		const latestTerminalSeq = this.getLatestTerminalSeq(sessionId);
		const latestRecoveryRelevantSeq = this.getLatestRecoveryRelevantSeq(sessionId);
		return {
			maxSeq,
			latestTerminalSeq,
			writerActive,
			hasIncompleteTail: writerActive || latestRecoveryRelevantSeq > latestTerminalSeq,
		};
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
