import type { Database } from "bun:sqlite";
import type { AgentCost } from "./events.ts";

export class CostTracker {
	private db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	record(sessionKey: string, cost: AgentCost, model: string): void {
		this.db.run(
			`INSERT INTO cost_events (session_key, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				sessionKey,
				cost.totalUsd,
				cost.inputTokens,
				cost.outputTokens,
				cost.cacheReadTokens,
				cost.cacheCreationTokens,
				model,
			],
		);

		this.db.run(
			`UPDATE sessions SET
				total_cost_usd = total_cost_usd + ?,
				input_tokens = input_tokens + ?,
				output_tokens = output_tokens + ?,
				cache_read_tokens = cache_read_tokens + ?,
				cache_creation_tokens = cache_creation_tokens + ?,
				turn_count = turn_count + 1,
				last_active_at = datetime('now')
			 WHERE session_key = ?`,
			[cost.totalUsd, cost.inputTokens, cost.outputTokens, cost.cacheReadTokens, cost.cacheCreationTokens, sessionKey],
		);
	}

	getSessionCost(sessionKey: string): number {
		const row = this.db.query("SELECT total_cost_usd FROM sessions WHERE session_key = ?").get(sessionKey) as {
			total_cost_usd: number;
		} | null;
		return row?.total_cost_usd ?? 0;
	}

	getCostEvents(sessionKey: string): CostEvent[] {
		return this.db
			.query("SELECT * FROM cost_events WHERE session_key = ? ORDER BY created_at DESC")
			.all(sessionKey) as CostEvent[];
	}
}

export type CostEvent = {
	id: number;
	session_key: string;
	cost_usd: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	model: string;
	created_at: string;
};
