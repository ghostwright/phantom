import type { Database } from "bun:sqlite";
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { PhantomConfig } from "../config/types.ts";
import type { EvolutionEngine } from "../evolution/engine.ts";
import type { MemorySystem } from "../memory/system.ts";

export type ResourceDependencies = {
	config: PhantomConfig;
	db: Database;
	startedAt: number;
	memory: MemorySystem | null;
	evolution: EvolutionEngine | null;
};

export function registerResources(server: McpServer, deps: ResourceDependencies): void {
	registerHealthResource(server, deps);
	registerIdentityResource(server, deps);
	registerConfigCurrentResource(server, deps);
	registerConfigChangelogResource(server, deps);
	registerTasksActiveResource(server, deps);
	registerTasksCompletedResource(server, deps);
	registerMetricsSummaryResource(server, deps);
	registerMetricsCostResource(server, deps);
	registerMemoryRecentResource(server, deps);
	registerMemoryDomainResource(server, deps);
}

function registerHealthResource(server: McpServer, deps: ResourceDependencies): void {
	server.registerResource(
		"health",
		"phantom://health",
		{
			description: "System health status and service availability",
			mimeType: "application/json",
		},
		async (): Promise<ReadResourceResult> => {
			const memoryHealth = deps.memory
				? await deps.memory.healthCheck().catch(() => ({ clawmem: false, configured: false }))
				: { clawmem: false, configured: false };

			const uptimeSeconds = Math.floor((Date.now() - deps.startedAt) / 1000);
			const status = memoryHealth.clawmem ? "ok" : memoryHealth.configured ? "down" : "ok";

			return {
				contents: [
					{
						uri: "phantom://health",
						text: JSON.stringify(
							{
								status,
								uptime: uptimeSeconds,
								version: "0.4.0",
								agent: deps.config.name,
								memory: memoryHealth,
								evolution: {
									generation: deps.evolution?.getCurrentVersion() ?? 0,
								},
							},
							null,
							2,
						),
					},
				],
			};
		},
	);
}

function registerIdentityResource(server: McpServer, deps: ResourceDependencies): void {
	server.registerResource(
		"identity",
		"phantom://identity",
		{
			description: "The Phantom's role, name, and capability description",
			mimeType: "application/json",
		},
		async (): Promise<ReadResourceResult> => {
			const persona = deps.evolution?.getConfig().persona ?? "";
			return {
				contents: [
					{
						uri: "phantom://identity",
						text: JSON.stringify(
							{
								name: deps.config.name,
								role: deps.config.role,
								model: deps.config.model,
								persona: persona.slice(0, 1000),
								capabilities: [
									"phantom_ask",
									"phantom_status",
									"phantom_memory_query",
									"phantom_task_create",
									"phantom_task_status",
									"phantom_config",
									"phantom_history",
									"phantom_metrics",
								],
							},
							null,
							2,
						),
					},
				],
			};
		},
	);
}

function registerConfigCurrentResource(server: McpServer, deps: ResourceDependencies): void {
	server.registerResource(
		"config-current",
		"phantom://config/current",
		{
			description: "The Phantom's current evolved configuration in full",
			mimeType: "application/json",
		},
		async (): Promise<ReadResourceResult> => {
			if (!deps.evolution) {
				return {
					contents: [{ uri: "phantom://config/current", text: JSON.stringify({ error: "Evolution not available" }) }],
				};
			}

			const config = deps.evolution.getConfig();
			return {
				contents: [
					{
						uri: "phantom://config/current",
						text: JSON.stringify(config, null, 2),
					},
				],
			};
		},
	);
}

function registerConfigChangelogResource(server: McpServer, deps: ResourceDependencies): void {
	server.registerResource(
		"config-changelog",
		"phantom://config/changelog",
		{
			description: "History of configuration changes from the evolution engine",
			mimeType: "application/json",
		},
		async (): Promise<ReadResourceResult> => {
			if (!deps.evolution) {
				return { contents: [{ uri: "phantom://config/changelog", text: JSON.stringify({ versions: [] }) }] };
			}

			const history = deps.evolution.getVersionHistory(20);
			return {
				contents: [
					{
						uri: "phantom://config/changelog",
						text: JSON.stringify({ versions: history }, null, 2),
					},
				],
			};
		},
	);
}

function registerTasksActiveResource(server: McpServer, deps: ResourceDependencies): void {
	server.registerResource(
		"tasks-active",
		"phantom://tasks/active",
		{
			description: "Currently active and queued tasks",
			mimeType: "application/json",
		},
		async (): Promise<ReadResourceResult> => {
			const tasks = deps.db
				.query("SELECT * FROM tasks WHERE status IN ('queued', 'active') ORDER BY created_at DESC LIMIT 50")
				.all();

			return { contents: [{ uri: "phantom://tasks/active", text: JSON.stringify({ tasks }, null, 2) }] };
		},
	);
}

function registerTasksCompletedResource(server: McpServer, deps: ResourceDependencies): void {
	server.registerResource(
		"tasks-completed",
		"phantom://tasks/completed",
		{
			description: "Recently completed tasks with results",
			mimeType: "application/json",
		},
		async (): Promise<ReadResourceResult> => {
			const tasks = deps.db
				.query("SELECT * FROM tasks WHERE status IN ('completed', 'failed') ORDER BY completed_at DESC LIMIT 50")
				.all();

			return { contents: [{ uri: "phantom://tasks/completed", text: JSON.stringify({ tasks }, null, 2) }] };
		},
	);
}

function registerMetricsSummaryResource(server: McpServer, deps: ResourceDependencies): void {
	server.registerResource(
		"metrics-summary",
		"phantom://metrics/summary",
		{
			description: "Performance dashboard data including costs, sessions, and evolution stats",
			mimeType: "application/json",
		},
		async (): Promise<ReadResourceResult> => {
			const metrics = deps.evolution?.getMetrics();
			const costToday = deps.db
				.query("SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events WHERE created_at >= date('now')")
				.get() as { total: number } | null;

			return {
				contents: [
					{
						uri: "phantom://metrics/summary",
						text: JSON.stringify(
							{
								sessions: metrics?.session_count ?? 0,
								successRate: metrics?.success_rate_7d ?? 0,
								costToday: costToday?.total ?? 0,
								evolutionGeneration: deps.evolution?.getCurrentVersion() ?? 0,
								evolutionCount: metrics?.evolution_count ?? 0,
							},
							null,
							2,
						),
					},
				],
			};
		},
	);
}

function registerMetricsCostResource(server: McpServer, deps: ResourceDependencies): void {
	server.registerResource(
		"metrics-cost",
		new ResourceTemplate("phantom://metrics/cost/{period}", {
			list: async () => ({
				resources: [
					{ uri: "phantom://metrics/cost/today", name: "Cost: Today" },
					{ uri: "phantom://metrics/cost/week", name: "Cost: This Week" },
					{ uri: "phantom://metrics/cost/month", name: "Cost: This Month" },
				],
			}),
		}),
		{
			description: "Cost breakdown by period",
			mimeType: "application/json",
		},
		async (uri, { period }): Promise<ReadResourceResult> => {
			const dateFilter =
				period === "today" ? "date('now')" : period === "week" ? "date('now', '-7 days')" : "date('now', '-30 days')";

			const row = deps.db
				.query(
					`SELECT COALESCE(SUM(cost_usd), 0) as total, COUNT(*) as events FROM cost_events WHERE created_at >= ${dateFilter}`,
				)
				.get() as { total: number; events: number };

			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify({ period, totalCost: row.total, events: row.events }, null, 2),
					},
				],
			};
		},
	);
}

function registerMemoryRecentResource(server: McpServer, deps: ResourceDependencies): void {
	server.registerResource(
		"memory-recent",
		"phantom://memory/recent",
		{
			description: "Recent episodic memories from the Phantom's experience",
			mimeType: "application/json",
		},
		async (): Promise<ReadResourceResult> => {
			if (!deps.memory || !deps.memory.isReady()) {
				return {
					contents: [{ uri: "phantom://memory/recent", text: JSON.stringify({ episodes: [], available: false }) }],
				};
			}

			const episodes = await deps.memory.recallEpisodes("recent activity", { limit: 10 }).catch(() => []);
			return {
				contents: [
					{
						uri: "phantom://memory/recent",
						text: JSON.stringify({ episodes, count: episodes.length }, null, 2),
					},
				],
			};
		},
	);
}

function registerMemoryDomainResource(server: McpServer, deps: ResourceDependencies): void {
	server.registerResource(
		"memory-domain",
		new ResourceTemplate("phantom://memory/domain/{topic}", {
			list: async () => ({
				resources: [
					{ uri: "phantom://memory/domain/codebase", name: "Memory: Codebase" },
					{ uri: "phantom://memory/domain/errors", name: "Memory: Errors" },
					{ uri: "phantom://memory/domain/processes", name: "Memory: Processes" },
				],
			}),
		}),
		{
			description: "Semantic memory filtered by topic",
			mimeType: "application/json",
		},
		async (uri, { topic }): Promise<ReadResourceResult> => {
			if (!deps.memory || !deps.memory.isReady()) {
				return { contents: [{ uri: uri.href, text: JSON.stringify({ facts: [], available: false }) }] };
			}

			const facts = await deps.memory.recallFacts(topic as string, { limit: 20 }).catch(() => []);
			return {
				contents: [
					{
						uri: uri.href,
						text: JSON.stringify({ topic, facts, count: facts.length }, null, 2),
					},
				],
			};
		},
	);
}
