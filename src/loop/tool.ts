import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { slackContextStore } from "../agent/slack-context.ts";
import type { LoopRunner } from "./runner.ts";
import { parseFrontmatter, readStateFile } from "./state-file.ts";
import type { Loop } from "./types.ts";

export const LOOP_TOOL_NAME = "phantom_loop";

function ok(data: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
	return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

function serializeLoop(loop: Loop): Record<string, unknown> {
	return {
		id: loop.id,
		goal: loop.goal,
		workspace_dir: loop.workspaceDir,
		state_file: loop.stateFile,
		status: loop.status,
		iteration_count: loop.iterationCount,
		max_iterations: loop.maxIterations,
		total_cost_usd: loop.totalCostUsd,
		max_cost_usd: loop.maxCostUsd,
		started_at: loop.startedAt,
		last_tick_at: loop.lastTickAt,
		finished_at: loop.finishedAt,
		last_error: loop.lastError,
	};
}

/**
 * In-process MCP tools that let the agent spawn and control ralph loops.
 * Exposed via createLoopToolServer, registered in src/index.ts alongside
 * the scheduler tool server.
 */
export function createLoopToolServer(runner: LoopRunner): McpSdkServerConfigWithInstance {
	const loopTool = tool(
		LOOP_TOOL_NAME,
		`Start, check, stop, or list "ralph loops" - autonomous iteration primitives.

A ralph loop runs the agent against a goal repeatedly, each iteration in a fresh
session, with state persisted in a markdown file the agent reads and rewrites.
The loop terminates when: (1) the agent sets status: done in the state file,
(2) iteration or cost budget is exhausted, (3) an optional success_command
returns exit 0, or (4) the operator interrupts it.

ACTIONS:
- start: Begin a new loop. Requires "goal". Returns the loop_id. Optional:
    workspace (defaults to data/loops/<id>/),
    max_iterations (default 20, hard ceiling 200),
    max_cost_usd (default 5, hard ceiling 50),
    checkpoint_interval (run a Sonnet critique every N ticks, 0 or omitted = off),
    success_command (shell command run after each tick; exit 0 = goal
      achieved. Runs under bash -c with a 5 minute timeout in a sanitized env
      containing only PATH, HOME, LANG, TERM, loop_id, and workspace),
    channel_id + conversation_id (Slack channel/thread for status updates).
- status: Inspect a loop. Returns row data + parsed state file frontmatter.
- stop: Request graceful stop of a running loop (takes effect before next tick).
- list: List active loops, or include_finished: true for recent history.

Use start for long-horizon tasks the agent should grind on in the background:
"keep refactoring until tests pass", "iterate on this design doc", "bisect this
regression". Each iteration is fresh - all context must live in the state file.`,
		{
			action: z.enum(["start", "status", "stop", "list"]),
			goal: z.string().optional().describe("The goal (required for start)"),
			workspace: z.string().optional(),
			max_iterations: z.number().int().positive().max(200).optional(),
			max_cost_usd: z.number().positive().max(50).optional(),
			checkpoint_interval: z
				.number()
				.int()
				.min(0)
				.max(200)
				.optional()
				.describe("Run a Sonnet review every N ticks. 0 or omitted = no critique."),
			success_command: z.string().optional(),
			channel_id: z.string().optional(),
			conversation_id: z.string().optional(),
			trigger_message_ts: z.string().optional(),
			loop_id: z.string().optional().describe("Loop ID (required for status and stop)"),
			include_finished: z.boolean().optional().describe("For list: include terminated loops"),
		},
		async (input) => {
			try {
				switch (input.action) {
					case "start": {
						if (!input.goal) return err("goal is required for start");
						// Explicit tool arguments always win. When the agent omits
						// channel/thread plumbing, fall back to the Slack context
						// captured by the router for the current turn.
						const ctx = slackContextStore.getStore();
						const loop = runner.start({
							goal: input.goal,
							workspace: input.workspace,
							maxIterations: input.max_iterations,
							maxCostUsd: input.max_cost_usd,
							checkpointInterval: input.checkpoint_interval,
							successCommand: input.success_command,
							channelId: input.channel_id ?? ctx?.slackChannelId,
							conversationId: input.conversation_id ?? ctx?.slackThreadTs,
							triggerMessageTs: input.trigger_message_ts ?? ctx?.slackMessageTs,
						});
						return ok({ started: true, loop: serializeLoop(loop) });
					}

					case "status": {
						if (!input.loop_id) return err("loop_id is required for status");
						const loop = runner.getLoop(input.loop_id);
						if (!loop) return err(`Loop not found: ${input.loop_id}`);
						let frontmatter: ReturnType<typeof parseFrontmatter> = null;
						let stateExcerpt = "";
						try {
							const contents = readStateFile(loop.stateFile);
							frontmatter = parseFrontmatter(contents);
							stateExcerpt = contents.split("\n").slice(0, 40).join("\n");
						} catch {
							// state file may have been removed manually; report what we have
						}
						return ok({ loop: serializeLoop(loop), frontmatter, state_excerpt: stateExcerpt });
					}

					case "stop": {
						if (!input.loop_id) return err("loop_id is required for stop");
						const stopped = runner.requestStop(input.loop_id);
						return ok({ stop_requested: stopped, loop_id: input.loop_id });
					}

					case "list": {
						const loops = runner.list(input.include_finished ?? false);
						return ok({ count: loops.length, loops: loops.map(serializeLoop) });
					}

					default:
						return err(`Unknown action: ${input.action}`);
				}
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				return err(msg);
			}
		},
	);

	return createSdkMcpServer({
		name: "phantom-loop",
		tools: [loopTool],
	});
}
