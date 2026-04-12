import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { runMigrations } from "../../db/migrate.ts";
import { hashTokenSync } from "../config.ts";
import { PhantomMcpServer } from "../server.ts";

function createMockRuntime() {
	return {
		handleMessage: async (_ch: string, _conv: string, text: string) => ({
			text: `Mock review: ${text.slice(0, 50)}`,
			sessionId: "mock-session",
			cost: {
				totalUsd: 0.05,
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				modelUsage: {},
			},
			durationMs: 5000,
		}),
		getActiveSessionCount: () => 0,
		getLastTrackedFiles: () => [],
		setMemoryContextBuilder: () => {},
		setEvolvedConfig: () => {},
		setRoleTemplate: () => {},
	};
}

function createMockEvolution() {
	return {
		getCurrentVersion: () => 2,
		getConfig: () => ({
			constitution: "Be helpful.",
			persona: "Technical communicator.",
			userProfile: "SWE team lead",
			domainKnowledge: "The codebase uses Rails 8 with RSpec and PostgreSQL.",
			strategies: {
				taskPatterns: "Read code first, then implement.",
				toolPreferences: "Use grep before writing new code.",
				errorRecovery: "Check CI logs first.",
			},
			meta: { version: 2, metricsSnapshot: { session_count: 10, success_rate_7d: 0.9, correction_rate_7d: 0.1 } },
		}),
		getMetrics: () => ({
			session_count: 10,
			success_count: 9,
			failure_count: 1,
			correction_count: 1,
			evolution_count: 2,
			rollback_count: 0,
			last_session_at: new Date().toISOString(),
			last_evolution_at: new Date().toISOString(),
			success_rate_7d: 0.9,
			correction_rate_7d: 0.1,
			sessions_since_consolidation: 2,
		}),
		getVersionHistory: () => [],
	};
}

const MCP_HEADERS = {
	"Content-Type": "application/json",
	Accept: "application/json, text/event-stream",
};

function mcpRequest(token: string, body: unknown, sessionId?: string): Request {
	const headers: Record<string, string> = { ...MCP_HEADERS, Authorization: `Bearer ${token}` };
	if (sessionId) headers["Mcp-Session-Id"] = sessionId;
	return new Request("http://localhost:3100/mcp", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

async function initSession(server: PhantomMcpServer, token: string): Promise<string> {
	const res = await server.handleRequest(
		mcpRequest(token, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "swe-test-client", version: "1.0" },
			},
		}),
	);
	const sessionId = res.headers.get("mcp-session-id") ?? "";
	await server.handleRequest(mcpRequest(token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId));
	return sessionId;
}

async function callTool(
	server: PhantomMcpServer,
	token: string,
	sessionId: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await server.handleRequest(
		mcpRequest(
			token,
			{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: args } },
			sessionId,
		),
	);
	const body = (await res.json()) as Record<string, unknown>;
	const result = body.result as Record<string, unknown>;
	const content = result.content as Array<{ type: string; text: string }>;
	return JSON.parse(content[0].text);
}

describe("SWE MCP Tools", () => {
	let db: Database;
	let mcpServer: PhantomMcpServer;
	const adminToken = "swe-mcp-tools-test-token";
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, "tmp-swe-tools-test");
		if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

		const mcpConfig = {
			tokens: [{ name: "swe-tester", hash: hashTokenSync(adminToken), scopes: ["read", "operator", "admin"] }],
			rate_limit: { requests_per_minute: 100, burst: 50 },
		};
		writeFileSync(join(tmpDir, "mcp.yaml"), stringify(mcpConfig));

		db = new Database(":memory:");
		runMigrations(db);

		mcpServer = new PhantomMcpServer(
			{
				config: {
					name: "swe-test-phantom",
					port: 3100,
					role: "swe",
					model: "claude-opus-4-6",
					model_source: "config" as const,
					effort: "max" as const,
					max_budget_usd: 0,
					timeout_minutes: 240,
				},
				db,
				startedAt: Date.now(),
				runtime: createMockRuntime() as never,
				memory: null,
				evolution: createMockEvolution() as never,
				roleId: "swe",
			},
			join(tmpDir, "mcp.yaml"),
		);
	});

	afterAll(async () => {
		await mcpServer.close();
		db.close();
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	});

	test("SWE tools appear alongside universal tools in tools/list", async () => {
		const sessionId = await initSession(mcpServer, adminToken);
		const res = await mcpServer.handleRequest(
			mcpRequest(adminToken, { jsonrpc: "2.0", id: 10, method: "tools/list" }, sessionId),
		);
		const body = (await res.json()) as Record<string, unknown>;
		const result = body.result as { tools: Array<{ name: string }> };
		const toolNames = result.tools.map((t) => t.name);

		// Universal tools (8)
		expect(toolNames).toContain("phantom_status");
		expect(toolNames).toContain("phantom_ask");
		expect(toolNames).toContain("phantom_memory_query");
		expect(toolNames).toContain("phantom_config");
		expect(toolNames).toContain("phantom_metrics");
		expect(toolNames).toContain("phantom_history");
		expect(toolNames).toContain("phantom_task_create");
		expect(toolNames).toContain("phantom_task_status");

		// SWE-specific tools (6)
		expect(toolNames).toContain("phantom_codebase_query");
		expect(toolNames).toContain("phantom_pr_status");
		expect(toolNames).toContain("phantom_ci_status");
		expect(toolNames).toContain("phantom_review_request");
		expect(toolNames).toContain("phantom_deploy_status");
		expect(toolNames).toContain("phantom_repo_info");
	});

	test("total tool count is 17 (8 universal + 6 SWE + 3 dynamic management)", async () => {
		const sessionId = await initSession(mcpServer, adminToken);
		const res = await mcpServer.handleRequest(
			mcpRequest(adminToken, { jsonrpc: "2.0", id: 11, method: "tools/list" }, sessionId),
		);
		const body = (await res.json()) as Record<string, unknown>;
		const result = body.result as { tools: Array<{ name: string }> };
		expect(result.tools).toHaveLength(17);
	});

	test("phantom_codebase_query returns domain knowledge", async () => {
		const sessionId = await initSession(mcpServer, adminToken);
		const result = await callTool(mcpServer, adminToken, sessionId, "phantom_codebase_query", {
			query: "What framework?",
		});
		expect(result.domain_knowledge).toContain("Rails 8");
	});

	test("phantom_codebase_query returns strategies for patterns scope", async () => {
		const sessionId = await initSession(mcpServer, adminToken);
		const result = await callTool(mcpServer, adminToken, sessionId, "phantom_codebase_query", {
			query: "How to approach tasks?",
			scope: "patterns",
		});
		expect(result.task_patterns).toContain("Read code first");
		expect(result.tool_preferences).toContain("grep");
	});

	test("phantom_pr_status returns not_connected", async () => {
		const sessionId = await initSession(mcpServer, adminToken);
		const result = await callTool(mcpServer, adminToken, sessionId, "phantom_pr_status", {});
		expect(result.status).toBe("not_connected");
		expect(result.message as string).toContain("not yet configured");
	});

	test("phantom_ci_status returns not_connected", async () => {
		const sessionId = await initSession(mcpServer, adminToken);
		const result = await callTool(mcpServer, adminToken, sessionId, "phantom_ci_status", {});
		expect(result.status).toBe("not_connected");
	});

	test("phantom_deploy_status returns not_connected", async () => {
		const sessionId = await initSession(mcpServer, adminToken);
		const result = await callTool(mcpServer, adminToken, sessionId, "phantom_deploy_status", {});
		expect(result.status).toBe("not_connected");
	});

	test("phantom_repo_info returns accumulated knowledge", async () => {
		const sessionId = await initSession(mcpServer, adminToken);
		const result = await callTool(mcpServer, adminToken, sessionId, "phantom_repo_info", {
			aspect: "overview",
		});
		expect(result.accumulated_knowledge).toContain("Rails 8");
	});
});
