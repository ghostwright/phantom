// In-process MCP server exposing reflective memory and session tools to the
// agent itself, so the built-in reflective skills (mirror, thread, echo,
// overheard, ritual) can actually fire.
//
// The external MCP server at /mcp already has similar tools for outside
// clients (phantom_memory_query, phantom_history). Those are served by
// src/mcp/tools-universal.ts. The Agent SDK subprocess cannot see the external
// MCP server without going through HTTP, so we expose a thin in-process server
// with two tools and register it via runtime.setMcpServerFactories() in
// src/index.ts.
//
// Naming note: we call the tools phantom_memory_search and
// phantom_list_sessions (matching the SKILL.md allowed-tools field) even
// though the external server's equivalents are called phantom_memory_query
// and phantom_history. The builder brief and the skill catalog use the new
// names; the old external-facing names stay for backward compatibility.

import type { Database } from "bun:sqlite";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { MemorySystem } from "../memory/system.ts";
import type { RecallOptions } from "../memory/types.ts";

type DbRow = Record<string, unknown>;

function ok(data: unknown): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
		isError: true,
	};
}

function daysAgo(n: number): Date {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - n);
	return d;
}

export function createReflectiveToolServer(memory: MemorySystem | null, db: Database): McpSdkServerConfigWithInstance {
	const memorySearch = tool(
		"phantom_memory_search",
		`Search the agent's persistent memory for past sessions, topics, and facts. Supports semantic search and temporal filtering.

Use this when reflecting on past behavior, looking up prior conversations, finding patterns, or checking whether a question has already been resolved. Returns episodes (past conversation turns with outcomes), facts (learned knowledge about the user, team, codebase), and optional procedures.

- query: the semantic search text. For temporal scans, use a broad query like "this week" or the topic keyword.
- memory_type: "episodic" for past sessions, "semantic" for facts, "all" for both. Default is "all".
- days_back: optional. Limits results to items from the last N days.
- limit: max results per type. Default 10, max 50.

Each episode includes summary, detail, outcome, started_at, tools_used, and lessons. Facts include natural_language, category, confidence, and valid_from.`,
		{
			query: z.string().min(1).describe("Semantic search text or topic keyword"),
			memory_type: z
				.enum(["episodic", "semantic", "all"])
				.optional()
				.default("all")
				.describe("Which memory tier to search"),
			days_back: z.number().int().min(1).max(365).optional().describe("Optional: limit to items from the last N days"),
			limit: z.number().int().min(1).max(50).optional().default(10).describe("Max results per tier"),
		},
		async (input) => {
			if (!memory || !memory.isReady()) {
				return ok({
					warning: "Memory system is not available. Returning empty results.",
					results: { episodes: [], facts: [] },
					totalMatches: 0,
				});
			}
			try {
				const limit = input.limit ?? 10;
				const opts: RecallOptions = { limit };
				if (input.days_back !== undefined) {
					opts.timeRange = { from: daysAgo(input.days_back), to: new Date() };
					opts.strategy = "temporal";
				}

				const results: Record<string, unknown[]> = {};

				if (input.memory_type === "episodic" || input.memory_type === "all") {
					results.episodes = await memory.recallEpisodes(input.query, opts).catch(() => []);
				}
				if (input.memory_type === "semantic" || input.memory_type === "all") {
					// Same opts so days_back also bounds semantic facts; otherwise a
					// weekly mirror leaks 6-month-old preferences into the result.
					results.facts = await memory.recallFacts(input.query, opts).catch(() => []);
				}

				const total = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
				return ok({
					query: input.query,
					days_back: input.days_back ?? null,
					results,
					totalMatches: total,
				});
			} catch (caught: unknown) {
				const msg = caught instanceof Error ? caught.message : String(caught);
				return err(`Memory search failed: ${msg}`);
			}
		},
	);

	const listSessions = tool(
		"phantom_list_sessions",
		`List recent conversation sessions the agent has had, with channel, start time, turn count, and total cost.

Use this to anchor reflective observations to specific days and channels, to count interactions across a window, or to pick the most expensive recent session for a cost explanation. Returns the most recently active sessions first.

- limit: max sessions to return. Default 20, max 200.
- days_back: optional. Only sessions active within the last N days.
- channel: optional. Substring filter on channel_id (e.g. "slack" to get all slack sessions).

Each row has session_key, channel_id, conversation_id, status, total_cost_usd, turn_count, created_at, last_active_at.`,
		{
			limit: z.number().int().min(1).max(200).optional().default(20),
			days_back: z.number().int().min(1).max(365).optional(),
			channel: z.string().optional(),
		},
		async (input) => {
			try {
				const conds: string[] = [];
				const params: unknown[] = [];
				if (input.days_back !== undefined) {
					const cutoff = daysAgo(input.days_back).toISOString();
					conds.push("last_active_at >= ?");
					params.push(cutoff);
				}
				if (input.channel) {
					conds.push("channel_id LIKE ?");
					params.push(`%${input.channel}%`);
				}
				const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
				const limit = input.limit ?? 20;
				params.push(limit);

				const rows = db
					.query(
						`SELECT session_key, sdk_session_id, channel_id, conversation_id, status,
						        total_cost_usd, input_tokens, output_tokens, turn_count,
						        created_at, last_active_at
						 FROM sessions
						 ${where}
						 ORDER BY last_active_at DESC
						 LIMIT ?`,
					)
					.all(...(params as string[])) as DbRow[];

				return ok({
					sessions: rows,
					count: rows.length,
					filters: {
						days_back: input.days_back ?? null,
						channel: input.channel ?? null,
					},
				});
			} catch (caught: unknown) {
				const msg = caught instanceof Error ? caught.message : String(caught);
				return err(`Session listing failed: ${msg}`);
			}
		},
	);

	return createSdkMcpServer({
		name: "phantom-reflective",
		tools: [memorySearch, listSessions],
	});
}
