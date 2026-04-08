import { z } from "zod";

export type LoopStatus = "running" | "done" | "stopped" | "budget_exceeded" | "failed";

export type Loop = {
	id: string;
	goal: string;
	workspaceDir: string;
	stateFile: string;
	successCommand: string | null;
	maxIterations: number;
	maxCostUsd: number;
	checkpointInterval: number | null;
	status: LoopStatus;
	iterationCount: number;
	totalCostUsd: number;
	channelId: string | null;
	conversationId: string | null;
	statusMessageTs: string | null;
	triggerMessageTs: string | null;
	interruptRequested: boolean;
	lastError: string | null;
	startedAt: string;
	lastTickAt: string | null;
	finishedAt: string | null;
};

export type LoopRow = {
	id: string;
	goal: string;
	workspace_dir: string;
	state_file: string;
	success_command: string | null;
	max_iterations: number;
	max_cost_usd: number;
	checkpoint_interval: number | null;
	status: string;
	iteration_count: number;
	total_cost_usd: number;
	channel_id: string | null;
	conversation_id: string | null;
	status_message_ts: string | null;
	trigger_message_ts: string | null;
	interrupt_requested: number;
	last_error: string | null;
	started_at: string;
	last_tick_at: string | null;
	finished_at: string | null;
};

export type LoopFrontmatter = {
	loopId: string;
	status: "in-progress" | "done" | "blocked";
	iteration: number;
};

export type LoopStartInput = {
	goal: string;
	workspace?: string;
	maxIterations?: number;
	maxCostUsd?: number;
	checkpointInterval?: number;
	successCommand?: string;
	channelId?: string;
	conversationId?: string;
	triggerMessageTs?: string;
};

// Hard ceilings the agent cannot raise. Caller-provided values are clamped.
export const LOOP_MAX_ITERATIONS_CEILING = 200;
export const LOOP_MAX_COST_CEILING_USD = 50;
export const LOOP_DEFAULT_MAX_ITERATIONS = 20;
export const LOOP_DEFAULT_MAX_COST_USD = 5;

export const LoopStartInputSchema = z.object({
	goal: z.string().min(1).max(10_000),
	workspace: z.string().optional(),
	max_iterations: z.number().int().positive().max(LOOP_MAX_ITERATIONS_CEILING).optional(),
	max_cost_usd: z.number().positive().max(LOOP_MAX_COST_CEILING_USD).optional(),
	checkpoint_interval: z.number().int().min(0).max(LOOP_MAX_ITERATIONS_CEILING).optional(),
	success_command: z.string().optional(),
	channel_id: z.string().optional(),
	conversation_id: z.string().optional(),
	trigger_message_ts: z.string().optional(),
});

export const LoopIdSchema = z.object({ loop_id: z.string().min(1) });

export const LoopListInputSchema = z.object({ include_finished: z.boolean().optional() });

export function rowToLoop(row: LoopRow): Loop {
	return {
		id: row.id,
		goal: row.goal,
		workspaceDir: row.workspace_dir,
		stateFile: row.state_file,
		successCommand: row.success_command,
		maxIterations: row.max_iterations,
		maxCostUsd: row.max_cost_usd,
		checkpointInterval: row.checkpoint_interval,
		status: row.status as LoopStatus,
		iterationCount: row.iteration_count,
		totalCostUsd: row.total_cost_usd,
		channelId: row.channel_id,
		conversationId: row.conversation_id,
		statusMessageTs: row.status_message_ts,
		triggerMessageTs: row.trigger_message_ts,
		interruptRequested: row.interrupt_requested === 1,
		lastError: row.last_error,
		startedAt: row.started_at,
		lastTickAt: row.last_tick_at,
		finishedAt: row.finished_at,
	};
}
