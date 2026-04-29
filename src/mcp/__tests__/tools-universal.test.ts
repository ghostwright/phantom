// Unit tests for the universal MCP tool registrations, with a focus on the
// PR3 alias expansion: phantom_list_sessions and phantom_memory_search are new
// names that coexist with the original phantom_history and phantom_memory_query
// registrations. The old names are untouched so existing external clients do
// not break; the new names expose a richer parameter set.
//
// Instead of spinning up the full PhantomMcpServer, we mock the McpServer
// interface by capturing every registerTool call into a map and invoking the
// captured handlers directly with the same shape as the real SDK.

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runMigrations } from "../../db/migrate.ts";
import type { Episode } from "../../memory/types.ts";
import { type ToolDependencies, registerUniversalTools } from "../tools-universal.ts";

type CapturedTool = {
	name: string;
	schema: unknown;
	handler: (input: unknown) => Promise<unknown> | unknown;
};

function createMockServer(): { server: McpServer; tools: Map<string, CapturedTool> } {
	const tools = new Map<string, CapturedTool>();
	const server = {
		registerTool: (name: string, schema: unknown, handler: CapturedTool["handler"]) => {
			tools.set(name, { name, schema, handler });
			return {} as unknown;
		},
	} as unknown as McpServer;
	return { server, tools };
}

function createMockRuntime(): ToolDependencies["runtime"] {
	return {
		getActiveSessionCount: () => 0,
		handleMessage: async () => ({
			text: "ok",
			sessionId: "sid",
			cost: { totalUsd: 0, inputTokens: 0, outputTokens: 0, modelUsage: {} },
			durationMs: 1,
		}),
	} as unknown as ToolDependencies["runtime"];
}

function createMockMemory(episodes: Episode[]): ToolDependencies["memory"] {
	return {
		isReady: () => true,
		recallEpisodes: async () => episodes,
		recallFacts: async () => [],
		findProcedure: async () => null,
	} as unknown as ToolDependencies["memory"];
}

function createEpisode(id: string, startedAt: string): Episode {
	return {
		id,
		type: "interaction",
		summary: "s",
		detail: "d",
		parent_id: null,
		session_id: "sess",
		user_id: "u",
		tools_used: [],
		files_touched: [],
		outcome: "success",
		outcome_detail: "",
		lessons: [],
		started_at: startedAt,
		ended_at: startedAt,
		duration_seconds: 1,
		importance: 1,
		access_count: 0,
		last_accessed_at: startedAt,
		decay_rate: 0.1,
	};
}

function seedSessions(db: Database): void {
	db.run("DELETE FROM sessions");
	const rows: Array<[string, string, string, string, string]> = [
		["slack:conv-a", "sid-a", "slack", "conv-a", new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()],
		["slack:conv-b", "sid-b", "slack", "conv-b", new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()],
		["cli:conv-c", "sid-c", "cli", "conv-c", new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()],
		["mcp:conv-d", "sid-d", "mcp", "conv-d", new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()],
	];
	for (const [sk, sdk, ch, conv, lastActive] of rows) {
		db.run(
			`INSERT INTO sessions (session_key, sdk_session_id, channel_id, conversation_id, status,
				total_cost_usd, input_tokens, output_tokens, turn_count, created_at, last_active_at)
			 VALUES (?, ?, ?, ?, 'active', 0, 0, 0, 0, datetime('now'), ?)`,
			[sk, sdk, ch, conv, lastActive],
		);
	}
}

let db: Database;
let deps: ToolDependencies;

beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db);
	seedSessions(db);
	deps = {
		config: {} as unknown as ToolDependencies["config"],
		db,
		startedAt: Date.now(),
		runtime: createMockRuntime(),
		memory: createMockMemory([
			createEpisode("recent-1", new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()),
			createEpisode("recent-2", new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()),
			createEpisode("old-1", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
		]),
		evolution: null,
	};
});

describe("registerUniversalTools: session listing tools", () => {
	test("registers phantom_history with the original schema", () => {
		const { server, tools } = createMockServer();
		registerUniversalTools(server, deps);
		expect(tools.has("phantom_history")).toBe(true);
	});

	test("registers phantom_list_sessions alongside phantom_history", () => {
		const { server, tools } = createMockServer();
		registerUniversalTools(server, deps);
		expect(tools.has("phantom_list_sessions")).toBe(true);
		expect(tools.has("phantom_history")).toBe(true);
	});

	test("phantom_history returns all sessions with the limit parameter", async () => {
		const { server, tools } = createMockServer();
		registerUniversalTools(server, deps);
		const tool = tools.get("phantom_history");
		const result = (await tool?.handler({ limit: 10 })) as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.count).toBe(4);
	});

	test("phantom_list_sessions filters by channel", async () => {
		const { server, tools } = createMockServer();
		registerUniversalTools(server, deps);
		const tool = tools.get("phantom_list_sessions");
		const result = (await tool?.handler({ limit: 10, channel: "slack" })) as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.count).toBe(2);
		for (const s of parsed.sessions) {
			expect(s.channel_id).toBe("slack");
		}
	});

	test("phantom_list_sessions filters by days_back", async () => {
		const { server, tools } = createMockServer();
		registerUniversalTools(server, deps);
		const tool = tools.get("phantom_list_sessions");
		const result = (await tool?.handler({ limit: 10, days_back: 7 })) as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text);
		// Only the two sessions from ~1 day ago pass the 7-day filter.
		expect(parsed.count).toBe(2);
	});

	test("phantom_list_sessions combines channel and days_back", async () => {
		const { server, tools } = createMockServer();
		registerUniversalTools(server, deps);
		const tool = tools.get("phantom_list_sessions");
		const result = (await tool?.handler({ limit: 10, channel: "slack", days_back: 7 })) as {
			content: Array<{ text: string }>;
		};
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.count).toBe(1);
		expect(parsed.sessions[0].channel_id).toBe("slack");
	});
});

describe("registerUniversalTools: memory search tools", () => {
	test("registers both phantom_memory_query and phantom_memory_search", () => {
		const { server, tools } = createMockServer();
		registerUniversalTools(server, deps);
		expect(tools.has("phantom_memory_query")).toBe(true);
		expect(tools.has("phantom_memory_search")).toBe(true);
	});

	test("phantom_memory_query returns all episodes without a recency filter", async () => {
		const { server, tools } = createMockServer();
		registerUniversalTools(server, deps);
		const tool = tools.get("phantom_memory_query");
		const result = (await tool?.handler({ query: "anything", memory_type: "episodic", limit: 10 })) as {
			content: Array<{ text: string }>;
		};
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.results.episodes.length).toBe(3);
	});

	test("phantom_memory_search with days_back filters older episodes", async () => {
		const { server, tools } = createMockServer();
		registerUniversalTools(server, deps);
		const tool = tools.get("phantom_memory_search");
		const result = (await tool?.handler({
			query: "anything",
			memory_type: "episodic",
			limit: 10,
			days_back: 7,
		})) as { content: Array<{ text: string }> };
		const parsed = JSON.parse(result.content[0].text);
		// The old-1 episode at ~30 days ago is filtered out; recent-1 and recent-2 remain.
		expect(parsed.results.episodes.length).toBe(2);
		expect(parsed.results.episodes.map((e: { id: string }) => e.id)).toEqual(["recent-1", "recent-2"]);
	});

	test("phantom_memory_search without days_back behaves like phantom_memory_query", async () => {
		const { server, tools } = createMockServer();
		registerUniversalTools(server, deps);
		const tool = tools.get("phantom_memory_search");
		const result = (await tool?.handler({ query: "anything", memory_type: "episodic", limit: 10 })) as {
			content: Array<{ text: string }>;
		};
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.results.episodes.length).toBe(3);
	});

	test("phantom_memory_search returns a clean error when memory is unavailable", async () => {
		const { server, tools } = createMockServer();
		registerUniversalTools(server, { ...deps, memory: null });
		const tool = tools.get("phantom_memory_search");
		const result = (await tool?.handler({ query: "x", memory_type: "all", limit: 10 })) as {
			content: Array<{ text: string }>;
		};
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.error).toBe("Memory system not available");
	});
});

describe("registerUniversalTools: full tool count", () => {
	test("registers all expected tools including both alias pairs", () => {
		const { server, tools } = createMockServer();
		registerUniversalTools(server, deps);
		const expected = [
			"phantom_status",
			"phantom_config",
			"phantom_metrics",
			"phantom_history",
			"phantom_list_sessions",
			"phantom_memory_query",
			"phantom_memory_search",
			"phantom_ask",
			"phantom_task_create",
			"phantom_task_status",
		];
		for (const name of expected) {
			expect(tools.has(name)).toBe(true);
		}
		expect(tools.size).toBe(expected.length);
	});
});
