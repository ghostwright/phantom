import type { Database } from "bun:sqlite";
import type { AgentCost } from "../agent/events.ts";
import type { ChatSessionStatus } from "./types.ts";

export type ChatSession = {
	id: string;
	owner_user_id: string;
	title: string | null;
	title_is_manual: number;
	status: ChatSessionStatus;
	created_at: string;
	updated_at: string;
	last_message_at: string | null;
	first_user_message_at: string | null;
	message_count: number;
	input_tokens: number;
	output_tokens: number;
	total_cost_usd: number;
	model: string | null;
	pinned: number;
	forked_from_session_id: string | null;
	forked_from_message_seq: number | null;
	deleted_at: string | null;
	metadata_json: string | null;
};

export type ChatSessionUpdate = {
	title: string;
	pinned: boolean;
	status: ChatSessionStatus;
};

export type ChatSessionListOptions = {
	limit?: number;
	cursor?: string;
	status?: ChatSessionStatus;
	includeBusy?: boolean;
};

export class ChatSessionStore {
	private db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	create(title?: string): ChatSession {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		this.db.run("INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			id,
			title ?? null,
			now,
			now,
		]);
		return this.get(id) as ChatSession;
	}

	get(id: string): ChatSession | null {
		return this.db
			.query("SELECT * FROM chat_sessions WHERE id = ? AND deleted_at IS NULL")
			.get(id) as ChatSession | null;
	}

	list(options: ChatSessionListOptions = {}): { sessions: ChatSession[]; nextCursor: string | null } {
		const limit = options.limit ?? 50;
		const status = options.status ?? "active";
		const params: (string | number)[] = [status];
		let cursorClause = "";

		if (options.cursor) {
			const parts = options.cursor.split("|");
			if (parts.length === 3) {
				cursorClause =
					"AND (pinned < ? OR (pinned = ? AND (COALESCE(last_message_at, created_at) < ? OR (COALESCE(last_message_at, created_at) = ? AND id < ?))))";
				params.push(parts[0], parts[0], parts[1], parts[1], parts[2]);
			}
		}

		params.push(limit + 1);
		const rows = this.db
			.query(
				`SELECT * FROM chat_sessions
				 WHERE status = ? AND deleted_at IS NULL ${cursorClause}
				 ORDER BY pinned DESC, COALESCE(last_message_at, created_at) DESC, id DESC
				 LIMIT ?`,
			)
			.all(...params) as ChatSession[];

		const hasMore = rows.length > limit;
		const sessions = hasMore ? rows.slice(0, limit) : rows;
		let nextCursor: string | null = null;

		if (hasMore && sessions.length > 0) {
			const last = sessions[sessions.length - 1];
			nextCursor = `${last.pinned}|${last.last_message_at ?? last.created_at}|${last.id}`;
		}

		return { sessions, nextCursor };
	}

	update(id: string, fields: Partial<ChatSessionUpdate>): void {
		const sets: string[] = ["updated_at = datetime('now')"];
		const params: (string | number)[] = [];

		if (fields.title !== undefined) {
			sets.push("title = ?");
			sets.push("title_is_manual = 1");
			params.push(fields.title);
		}
		if (fields.pinned !== undefined) {
			sets.push("pinned = ?");
			params.push(fields.pinned ? 1 : 0);
		}
		if (fields.status !== undefined) {
			sets.push("status = ?");
			params.push(fields.status);
		}

		params.push(id);
		this.db.run(`UPDATE chat_sessions SET ${sets.join(", ")} WHERE id = ?`, params);
	}

	softDelete(id: string): string {
		const undoUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
		this.db.run(`UPDATE chat_sessions SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, [
			id,
		]);
		return undoUntil;
	}

	fork(sourceId: string, fromMessageSeq: number): ChatSession {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		this.db.run(
			`INSERT INTO chat_sessions (id, forked_from_session_id, forked_from_message_seq, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)`,
			[id, sourceId, fromMessageSeq, now, now],
		);
		return this.get(id) as ChatSession;
	}

	incrementMessageCount(id: string): void {
		this.db.run(
			`UPDATE chat_sessions SET message_count = message_count + 1,
			 last_message_at = datetime('now'), updated_at = datetime('now')
			 WHERE id = ?`,
			[id],
		);
	}

	setFirstUserMessageAt(id: string): void {
		this.db.run(
			`UPDATE chat_sessions SET first_user_message_at = datetime('now')
			 WHERE id = ? AND first_user_message_at IS NULL`,
			[id],
		);
	}

	updateCost(id: string, cost: AgentCost): void {
		this.db.run(
			`UPDATE chat_sessions SET
			 total_cost_usd = total_cost_usd + ?,
			 input_tokens = input_tokens + ?,
			 output_tokens = output_tokens + ?,
			 updated_at = datetime('now')
			 WHERE id = ?`,
			[cost.totalUsd, cost.inputTokens, cost.outputTokens, id],
		);
	}

	resetTitle(id: string): void {
		this.db.run(
			`UPDATE chat_sessions SET title = NULL, title_is_manual = 0, updated_at = datetime('now')
			 WHERE id = ?`,
			[id],
		);
	}

	getExpiredSessionIds(olderThanDays: number): string[] {
		const rows = this.db
			.query(
				`SELECT id FROM chat_sessions
				 WHERE deleted_at IS NOT NULL
				 AND deleted_at < datetime('now', ?)`,
			)
			.all(`-${olderThanDays} days`) as Array<{ id: string }>;
		return rows.map((r) => r.id);
	}

	hardDeleteExpired(olderThanDays: number): number {
		const expiredIds = this.db
			.query(
				`SELECT id FROM chat_sessions
				 WHERE deleted_at IS NOT NULL
				 AND deleted_at < datetime('now', ?)`,
			)
			.all(`-${olderThanDays} days`) as Array<{ id: string }>;

		if (expiredIds.length === 0) return 0;

		const ids = expiredIds.map((r) => r.id);
		const placeholders = ids.map(() => "?").join(",");

		const txn = this.db.transaction(() => {
			this.db.run(`DELETE FROM chat_stream_events WHERE session_id IN (${placeholders})`, ids);
			this.db.run(`DELETE FROM chat_attachments WHERE session_id IN (${placeholders})`, ids);
			this.db.run(`DELETE FROM chat_messages WHERE session_id IN (${placeholders})`, ids);
			this.db.run(`DELETE FROM chat_sessions WHERE id IN (${placeholders})`, ids);
		});
		txn();

		return ids.length;
	}

	setAutoTitle(id: string, title: string): void {
		this.db.run(
			`UPDATE chat_sessions SET title = ?, updated_at = datetime('now')
			 WHERE id = ? AND title IS NULL AND title_is_manual = 0`,
			[title, id],
		);
	}
}
