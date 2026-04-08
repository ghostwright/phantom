import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../../db/migrate.ts";
import { hashTokenSync } from "../config.ts";
import { PhantomMcpServer } from "../server.ts";

/**
 * Tests that MCP tool calls enforce scopes at the HTTP dispatch layer.
 * Read-only tokens must be blocked from operator/admin tools.
 */

function createMockRuntime() {
	return {
		handleMessage: async (_ch: string, _conv: string, text: string) => ({
			text: `Mock response to: ${text}`,
			sessionId: "mock-session",
			cost: { totalUsd: 0.001, inputTokens: 100, outputTokens: 50, modelUsage: {} },
			durationMs: 100,
		}),
		getActiveSessionCount: () => 0,
		getLastTrackedFiles: () => [],
		setMemoryContextBuilder: () => {},
		setEvolvedConfig: () => {},
	};
}

function createMockEvolution() {
	return {
		getCurrentVersion: () => 1,
		getConfig: () => ({
			constitution: "",
			persona: "",
			userProfile: "",
			domainKnowledge: "",
			strategies: { taskPatterns: "", toolPreferences: "", errorRecovery: "" },
			meta: { version: 1, metricsSnapshot: { session_count: 0, success_rate_7d: 0, correction_rate_7d: 0 } },
		}),
		getMetrics: () => ({
			session_count: 0,
			success_count: 0,
			failure_count: 0,
			correction_count: 0,
			evolution_count: 0,
			rollback_count: 0,
			last_session_at: "",
			last_evolution_at: "",
			success_rate_7d: 0,
			correction_rate_7d: 0,
			sessions_since_consolidation: 0,
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

function initBody(clientName = "scope-test") {
	return {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: clientName, version: "1.0" },
		},
	};
}

function toolsCallBody(toolName: string, id = 2) {
	return {
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name: toolName, arguments: {} },
	};
}

async function initSession(server: PhantomMcpServer, token: string, name: string): Promise<string> {
	const res = await server.handleRequest(mcpRequest(token, initBody(name)));
	const sessionId = res.headers.get("mcp-session-id") ?? "";
	await server.handleRequest(mcpRequest(token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId));
	return sessionId;
}

describe("MCP scope enforcement", () => {
	let db: Database;
	let mcpServer: PhantomMcpServer;
	let tmpDir: string;

	const adminToken = "scope-test-admin-token";
	const operatorToken = "scope-test-operator-token";
	const readToken = "scope-test-read-token";

	beforeAll(async () => {
		const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
		const { join } = await import("node:path");
		const YAML = (await import("yaml")).default;

		db = new Database(":memory:");
		runMigrations(db);

		tmpDir = join(import.meta.dir, "tmp-scope-test");
		if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
		const configPath = join(tmpDir, "mcp.yaml");

		const mcpConfig = {
			tokens: [
				{ name: "admin", hash: hashTokenSync(adminToken), scopes: ["read", "operator", "admin"] },
				{ name: "operator", hash: hashTokenSync(operatorToken), scopes: ["read", "operator"] },
				{ name: "reader", hash: hashTokenSync(readToken), scopes: ["read"] },
			],
			rate_limit: { requests_per_minute: 120, burst: 20 },
		};
		writeFileSync(configPath, YAML.stringify(mcpConfig));

		mcpServer = new PhantomMcpServer(
			{
				config: {
					name: "scope-test",
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
			},
			configPath,
		);
	});

	afterAll(async () => {
		await mcpServer.close();
		db.close();
		const { rmSync, existsSync } = await import("node:fs");
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	});

	test("read-only token calling phantom_ask gets 403", async () => {
		const res = await mcpServer.handleRequest(mcpRequest(readToken, toolsCallBody("phantom_ask")));
		expect(res.status).toBe(403);
		const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string } };
		expect(body.error.code).toBe(-32001);
		expect(body.error.message).toContain("operator");
	});

	test("read-only token calling phantom_status gets 200", async () => {
		const sessionId = await initSession(mcpServer, readToken, "read-status");
		const res = await mcpServer.handleRequest(mcpRequest(readToken, toolsCallBody("phantom_status"), sessionId));
		expect(res.status).toBe(200);
	});

	test("admin token calling phantom_register_tool gets 200", async () => {
		const sessionId = await initSession(mcpServer, adminToken, "admin-register");
		const res = await mcpServer.handleRequest(
			mcpRequest(
				adminToken,
				{
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: {
						name: "phantom_register_tool",
						arguments: {
							name: "test_scope_tool",
							description: "test",
							handler_type: "shell",
							handler_code: "echo test",
						},
					},
				},
				sessionId,
			),
		);
		expect(res.status).toBe(200);
	});

	test("operator token calling phantom_ask gets 200", async () => {
		// phantom_ask requires operator scope. operator token has ["read", "operator"].
		// This test just verifies the scope check passes (the tool itself may need
		// a session, so we check it does not get 403).
		const sessionId = await initSession(mcpServer, operatorToken, "op-ask");
		const res = await mcpServer.handleRequest(
			mcpRequest(
				operatorToken,
				{
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "phantom_ask", arguments: { message: "hello" } },
				},
				sessionId,
			),
		);
		// Should not be 403 (scope check passes), may be 200 (tool runs)
		expect(res.status).not.toBe(403);
	});

	test("operator token calling phantom_register_tool gets 403", async () => {
		const res = await mcpServer.handleRequest(mcpRequest(operatorToken, toolsCallBody("phantom_register_tool")));
		expect(res.status).toBe(403);
		const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string } };
		expect(body.error.message).toContain("admin");
	});

	test("non-tools/call request passes through unaffected", async () => {
		// resources/list is not a tools/call, should not trigger scope enforcement
		const sessionId = await initSession(mcpServer, readToken, "non-tools-call");
		const res = await mcpServer.handleRequest(
			mcpRequest(readToken, { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} }, sessionId),
		);
		expect(res.status).toBe(200);
	});

	test("malformed JSON body passes through", async () => {
		// A request with invalid JSON should not crash the scope enforcement
		const req = new Request("http://localhost:3100/mcp", {
			method: "POST",
			headers: { ...MCP_HEADERS, Authorization: `Bearer ${adminToken}` },
			body: "not valid json {{{",
		});
		const res = await mcpServer.handleRequest(req);
		// Transport should handle the parse error, not the scope check
		expect(res.status).not.toBe(403);
	});

	test("batch request with unauthorized tool call gets 403", async () => {
		// A batch JSON-RPC request wrapping a privileged tool call should still be caught
		const batch = [
			{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
			{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "phantom_register_tool", arguments: {} } },
		];
		const req = new Request("http://localhost:3100/mcp", {
			method: "POST",
			headers: { ...MCP_HEADERS, Authorization: `Bearer ${readToken}` },
			body: JSON.stringify(batch),
		});
		const res = await mcpServer.handleRequest(req);
		expect(res.status).toBe(403);
	});
});
