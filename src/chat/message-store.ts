import type { Database } from "bun:sqlite";

export type ChatMessage = {
	id: string;
	session_id: string;
	seq: number;
	parent_seq: number | null;
	role: string;
	content_json: string;
	created_at: string;
	completed_at: string | null;
	status: string;
	stop_reason: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cost_usd: number | null;
	model: string | null;
	error_text: string | null;
};

export type ChatMessageCommitParams = {
	sessionId: string;
	seq: number;
	role: string;
	contentJson: string;
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
	stopReason?: string;
};

export type ChatMessageUpdate = {
	status: string;
	completedAt: string;
	stopReason: string;
	errorText: string;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
};

export class ChatMessageStore {
	private db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	commit(params: ChatMessageCommitParams): string {
		const id = crypto.randomUUID();
		this.db.run(
			`INSERT INTO chat_messages (id, session_id, seq, role, content_json, model, input_tokens, output_tokens, cost_usd, stop_reason)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				params.sessionId,
				params.seq,
				params.role,
				params.contentJson,
				params.model ?? null,
				params.inputTokens ?? null,
				params.outputTokens ?? null,
				params.costUsd ?? null,
				params.stopReason ?? null,
			],
		);
		return id;
	}

	getBySession(sessionId: string, options?: { afterSeq?: number; limit?: number }): ChatMessage[] {
		const afterSeq = options?.afterSeq ?? -1;
		const limit = options?.limit ?? 1000;
		return this.db
			.query(
				`SELECT * FROM chat_messages
				 WHERE session_id = ? AND seq > ?
				 ORDER BY seq ASC
				 LIMIT ?`,
			)
			.all(sessionId, afterSeq, limit) as ChatMessage[];
	}

	getById(id: string): ChatMessage | null {
		return this.db.query("SELECT * FROM chat_messages WHERE id = ?").get(id) as ChatMessage | null;
	}

	updateStatus(id: string, status: string, fields?: Partial<ChatMessageUpdate>): void {
		const sets: string[] = ["status = ?"];
		const params: (string | number)[] = [status];

		if (fields?.completedAt !== undefined) {
			sets.push("completed_at = ?");
			params.push(fields.completedAt);
		}
		if (fields?.stopReason !== undefined) {
			sets.push("stop_reason = ?");
			params.push(fields.stopReason);
		}
		if (fields?.errorText !== undefined) {
			sets.push("error_text = ?");
			params.push(fields.errorText);
		}
		if (fields?.inputTokens !== undefined) {
			sets.push("input_tokens = ?");
			params.push(fields.inputTokens);
		}
		if (fields?.outputTokens !== undefined) {
			sets.push("output_tokens = ?");
			params.push(fields.outputTokens);
		}
		if (fields?.costUsd !== undefined) {
			sets.push("cost_usd = ?");
			params.push(fields.costUsd);
		}

		params.push(id);
		this.db.run(`UPDATE chat_messages SET ${sets.join(", ")} WHERE id = ?`, params);
	}

	getMaxSeq(sessionId: string): number {
		const row = this.db.query("SELECT MAX(seq) as max_seq FROM chat_messages WHERE session_id = ?").get(sessionId) as {
			max_seq: number | null;
		} | null;
		return row?.max_seq ?? 0;
	}

	deleteBySession(sessionId: string): number {
		const result = this.db.run("DELETE FROM chat_messages WHERE session_id = ?", [sessionId]);
		return result.changes;
	}
}
