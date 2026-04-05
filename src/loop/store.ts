import type { Database } from "bun:sqlite";
import { type Loop, type LoopRow, type LoopStatus, rowToLoop } from "./types.ts";

export type LoopInsertInput = {
	id: string;
	goal: string;
	workspaceDir: string;
	stateFile: string;
	successCommand: string | null;
	maxIterations: number;
	maxCostUsd: number;
	channelId: string | null;
	conversationId: string | null;
};

/**
 * SQLite persistence for the loop primitive. Kept thin: the runner owns all
 * lifecycle logic, the store just reads and writes rows.
 */
export class LoopStore {
	constructor(private db: Database) {}

	insert(input: LoopInsertInput): Loop {
		this.db.run(
			`INSERT INTO loops (id, goal, workspace_dir, state_file, success_command, max_iterations, max_cost_usd, status, channel_id, conversation_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
			[
				input.id,
				input.goal,
				input.workspaceDir,
				input.stateFile,
				input.successCommand,
				input.maxIterations,
				input.maxCostUsd,
				input.channelId,
				input.conversationId,
			],
		);
		const created = this.findById(input.id);
		if (!created) throw new Error(`Failed to insert loop: ${input.id}`);
		return created;
	}

	findById(id: string): Loop | null {
		const row = this.db.query("SELECT * FROM loops WHERE id = ?").get(id) as LoopRow | null;
		return row ? rowToLoop(row) : null;
	}

	listByStatus(status: LoopStatus): Loop[] {
		const rows = this.db.query("SELECT * FROM loops WHERE status = ? ORDER BY started_at ASC").all(status) as LoopRow[];
		return rows.map(rowToLoop);
	}

	listAll(includeFinished: boolean): Loop[] {
		const sql = includeFinished
			? "SELECT * FROM loops ORDER BY started_at DESC LIMIT 50"
			: "SELECT * FROM loops WHERE status = 'running' ORDER BY started_at ASC";
		const rows = this.db.query(sql).all() as LoopRow[];
		return rows.map(rowToLoop);
	}

	recordTick(id: string, iterationCount: number, addedCostUsd: number): void {
		this.db.run(
			`UPDATE loops SET iteration_count = ?, total_cost_usd = total_cost_usd + ?, last_tick_at = datetime('now') WHERE id = ?`,
			[iterationCount, addedCostUsd, id],
		);
	}

	requestStop(id: string): boolean {
		const result = this.db.run("UPDATE loops SET interrupt_requested = 1 WHERE id = ? AND status = 'running'", [id]);
		return result.changes > 0;
	}

	setStatusMessageTs(id: string, ts: string): void {
		this.db.run("UPDATE loops SET status_message_ts = ? WHERE id = ?", [ts, id]);
	}

	finalize(id: string, status: LoopStatus, lastError: string | null): void {
		this.db.run(`UPDATE loops SET status = ?, last_error = ?, finished_at = datetime('now') WHERE id = ?`, [
			status,
			lastError,
			id,
		]);
	}
}
