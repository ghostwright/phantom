import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../../db/migrate.ts";
import { hashTokenSync } from "../config.ts";
import { PhantomMcpServer } from "../server.ts";

function createMockRuntime() {
	return {
		handleMessage: async (_ch: string, _conv: string, text: string) => ({
			text: `Mock response to: ${text}`,
			sessionId: "mock-session",
			cost: {
				totalUsd: 0.001,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				modelUsage: {},
			},
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
		getCurrentVersion: () => 3,
		getConfig: () => ({
			constitution: "Be helpful and safe.",
			persona: "A test phantom.",
			userProfile: "Test user",
			domainKnowledge: "Test domain knowledge",
			strategies: { taskPatterns: "patterns", toolPreferences: "prefs", errorRecovery: "recovery" },
			meta: { version: 3, metricsSnapshot: { session_count: 10, success_rate_7d: 0.9, correction_rate_7d: 0.1 } },
		}),
		getMetrics: () => ({
			session_count: 10,
			success_count: 9,
			failure_count: 1,
			correction_count: 1,
			evolution_count: 3,
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

// MCP protocol requires Accept header with both types
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

function initBody(clientName = "test") {
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

async function initSession(server: PhantomMcpServer, token: string, name = "test"): Promise<string> {
	const res = await server.handleRequest(mcpRequest(token, initBody(name)));
	const sessionId = res.headers.get("mcp-session-id") ?? "";

	// Send initialized notification
	await server.handleRequest(mcpRequest(token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId));

	return sessionId;
}

describe("PhantomMcpServer", () => {
	let db: Database;
	let mcpServer: PhantomMcpServer;
	const adminToken = "test-admin-for-mcp-server";
	const readToken = "test-read-for-mcp-server";
	let tmpDir: string;

	beforeAll(async () => {
		const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
		const { join } = await import("node:path");
		const YAML = (await import("yaml")).default;

		db = new Database(":memory:");
		runMigrations(db);

		tmpDir = join(import.meta.dir, "tmp-mcp-server-test");
		if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
		const configPath = join(tmpDir, "mcp.yaml");

		const mcpConfig = {
			tokens: [
				{ name: "admin", hash: hashTokenSync(adminToken), scopes: ["read", "operator", "admin"] },
				{ name: "reader", hash: hashTokenSync(readToken), scopes: ["read"] },
			],
			rate_limit: { requests_per_minute: 60, burst: 10 },
		};
		writeFileSync(configPath, YAML.stringify(mcpConfig));

		const phantomConfig = {
			name: "test-phantom",
			port: 3100,
			role: "swe",
			model: "claude-opus-4-6",
			model_source: "config" as const,
			effort: "max" as const,
			max_budget_usd: 0,
			timeout_minutes: 240,
		};

		mcpServer = new PhantomMcpServer(
			{
				config: phantomConfig,
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

	test("rejects unauthenticated requests with 401", async () => {
		const req = new Request("http://localhost:3100/mcp", {
			method: "POST",
			headers: MCP_HEADERS,
			body: JSON.stringify(initBody()),
		});
		const res = await mcpServer.handleRequest(req);
		expect(res.status).toBe(401);
	});

	test("rejects invalid token with 401", async () => {
		const res = await mcpServer.handleRequest(mcpRequest("wrong-token", initBody()));
		expect(res.status).toBe(401);
	});

	test("handles MCP initialize with valid token", async () => {
		const res = await mcpServer.handleRequest(mcpRequest(adminToken, initBody("init-test")));
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.result).toBeDefined();
		expect(body.result.serverInfo.name).toContain("phantom");
	});

	test("phantom_status returns operational state", async () => {
		const sessionId = await initSession(mcpServer, adminToken, "status-test");

		const res = await mcpServer.handleRequest(
			mcpRequest(
				adminToken,
				{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "phantom_status", arguments: {} } },
				sessionId,
			),
		);
		expect(res.status).toBe(200);

		const body = await res.json();
		const status = JSON.parse(body.result.content[0].text);
		expect(status.state).toBe("idle");
		expect(typeof status.uptimeHours).toBe("number");
		expect(status.evolutionGeneration).toBe(3);
	});

	test("phantom://health resource returns data", async () => {
		const sessionId = await initSession(mcpServer, adminToken, "health-test");

		const res = await mcpServer.handleRequest(
			mcpRequest(
				adminToken,
				{ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "phantom://health" } },
				sessionId,
			),
		);
		expect(res.status).toBe(200);

		const body = await res.json();
		const health = JSON.parse(body.result.contents[0].text);
		expect(health.agent).toBe("test-phantom");
		expect(health.status).toBeDefined();
	});

	test("phantom_config returns evolution data", async () => {
		const sessionId = await initSession(mcpServer, adminToken, "config-test");

		const res = await mcpServer.handleRequest(
			mcpRequest(
				adminToken,
				{ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "phantom_config", arguments: {} } },
				sessionId,
			),
		);
		expect(res.status).toBe(200);

		const body = await res.json();
		const config = JSON.parse(body.result.content[0].text);
		expect(config.generation).toBe(3);
		expect(config.config).toBeDefined();
	});

	test("phantom_metrics returns stats", async () => {
		const sessionId = await initSession(mcpServer, adminToken, "metrics-test");

		const res = await mcpServer.handleRequest(
			mcpRequest(
				adminToken,
				{ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "phantom_metrics", arguments: {} } },
				sessionId,
			),
		);
		expect(res.status).toBe(200);

		const body = await res.json();
		const metrics = JSON.parse(body.result.content[0].text);
		expect(metrics.evolutionGeneration).toBe(3);
		expect(typeof metrics.successRate).toBe("number");
	});

	test("phantom_task_create and phantom_task_status", async () => {
		const sessionId = await initSession(mcpServer, adminToken, "task-test");

		// Create task
		const createRes = await mcpServer.handleRequest(
			mcpRequest(
				adminToken,
				{
					jsonrpc: "2.0",
					id: 6,
					method: "tools/call",
					params: {
						name: "phantom_task_create",
						arguments: { title: "Test task", description: "A test task", urgency: "high" },
					},
				},
				sessionId,
			),
		);
		expect(createRes.status).toBe(200);

		const createBody = await createRes.json();
		const taskData = JSON.parse(createBody.result.content[0].text);
		expect(taskData.taskId).toBeTruthy();
		expect(taskData.status).toBe("queued");

		// Check status
		const statusRes = await mcpServer.handleRequest(
			mcpRequest(
				adminToken,
				{
					jsonrpc: "2.0",
					id: 7,
					method: "tools/call",
					params: { name: "phantom_task_status", arguments: { taskId: taskData.taskId } },
				},
				sessionId,
			),
		);
		expect(statusRes.status).toBe(200);

		const statusBody = await statusRes.json();
		const task = JSON.parse(statusBody.result.content[0].text);
		expect(task.title).toBe("Test task");
		expect(task.urgency).toBe("high");
	});

	test("phantom_history returns session data", async () => {
		const sessionId = await initSession(mcpServer, adminToken, "history-test");

		const res = await mcpServer.handleRequest(
			mcpRequest(
				adminToken,
				{ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "phantom_history", arguments: {} } },
				sessionId,
			),
		);
		expect(res.status).toBe(200);

		const body = await res.json();
		const history = JSON.parse(body.result.content[0].text);
		expect(history.sessions).toBeDefined();
		expect(Array.isArray(history.sessions)).toBe(true);
	});

	test("rate limiting returns 429", async () => {
		const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
		const { join } = await import("node:path");
		const YAML = (await import("yaml")).default;

		const rlDir = join(import.meta.dir, "tmp-rate-test");
		if (!existsSync(rlDir)) mkdirSync(rlDir, { recursive: true });
		const configPath = join(rlDir, "mcp.yaml");

		const token = "rate-limit-test-token";
		writeFileSync(
			configPath,
			YAML.stringify({
				tokens: [{ name: "limited", hash: hashTokenSync(token), scopes: ["read"] }],
				rate_limit: { requests_per_minute: 2, burst: 1 },
			}),
		);

		const rlDb = new Database(":memory:");
		runMigrations(rlDb);

		const rlServer = new PhantomMcpServer(
			{
				config: {
					name: "limited",
					port: 3100,
					role: "swe",
					model: "claude-opus-4-6",
					model_source: "config" as const,
					effort: "max" as const,
					max_budget_usd: 0,
					timeout_minutes: 240,
				},
				db: rlDb,
				startedAt: Date.now(),
				runtime: createMockRuntime() as never,
				memory: null,
				evolution: null,
			},
			configPath,
		);

		// Drain all tokens (2 + 1 = 3)
		for (let i = 0; i < 3; i++) {
			await rlServer.handleRequest(mcpRequest(token, initBody(`rl-${i}`)));
		}

		const blocked = await rlServer.handleRequest(mcpRequest(token, initBody("rl-blocked")));
		expect(blocked.status).toBe(429);
		expect(blocked.headers.get("Retry-After")).toBeTruthy();

		await rlServer.close();
		rlDb.close();

		const { rmSync } = await import("node:fs");
		if (existsSync(rlDir)) rmSync(rlDir, { recursive: true });
	});

	test("audit log records interactions", async () => {
		const auditLog = mcpServer.getAuditLog(50);
		expect(auditLog.length).toBeGreaterThan(0);
	});

	test("phantom://config/current resource", async () => {
		const sessionId = await initSession(mcpServer, adminToken, "config-res-test");

		const res = await mcpServer.handleRequest(
			mcpRequest(
				adminToken,
				{ jsonrpc: "2.0", id: 10, method: "resources/read", params: { uri: "phantom://config/current" } },
				sessionId,
			),
		);
		expect(res.status).toBe(200);

		const body = await res.json();
		const config = JSON.parse(body.result.contents[0].text);
		expect(config.persona).toBeDefined();
	});

	test("phantom://identity resource", async () => {
		const sessionId = await initSession(mcpServer, adminToken, "identity-test");

		const res = await mcpServer.handleRequest(
			mcpRequest(
				adminToken,
				{ jsonrpc: "2.0", id: 11, method: "resources/read", params: { uri: "phantom://identity" } },
				sessionId,
			),
		);
		expect(res.status).toBe(200);

		const body = await res.json();
		const identity = JSON.parse(body.result.contents[0].text);
		expect(identity.name).toBe("test-phantom");
		expect(identity.role).toBe("swe");
	});
});
