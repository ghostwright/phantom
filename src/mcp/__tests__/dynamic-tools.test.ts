import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { runMigrations } from "../../db/migrate.ts";
import { hashTokenSync } from "../config.ts";
import { DynamicToolRegistry } from "../dynamic-tools.ts";
import { PhantomMcpServer } from "../server.ts";

function createMockRuntime() {
	return {
		handleMessage: async (_ch: string, _conv: string, text: string) => ({
			text: `Mock: ${text}`,
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
				clientInfo: { name: "dynamic-test", version: "1.0" },
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

describe("DynamicToolRegistry", () => {
	let db: Database;

	beforeAll(() => {
		db = new Database(":memory:");
		runMigrations(db);
	});

	afterAll(() => {
		db.close();
	});

	test("starts with zero tools", () => {
		const registry = new DynamicToolRegistry(db);
		expect(registry.count()).toBe(0);
	});

	test("registers a shell tool", () => {
		const registry = new DynamicToolRegistry(db);
		const def = registry.register({
			name: "test_hello",
			description: "Says hello",
			input_schema: { name: "string" },
			handler_type: "shell",
			handler_code: 'echo "Hello, world!"',
		});

		expect(def.name).toBe("test_hello");
		expect(def.description).toBe("Says hello");
		expect(def.handlerType).toBe("shell");
		expect(registry.has("test_hello")).toBe(true);
	});

	test("persists tools to SQLite", () => {
		const registry2 = new DynamicToolRegistry(db);
		expect(registry2.has("test_hello")).toBe(true);
		expect(registry2.count()).toBeGreaterThanOrEqual(1);
	});

	test("unregisters a tool", () => {
		const registry = new DynamicToolRegistry(db);
		registry.register({
			name: "to_remove",
			description: "Will be removed",
			input_schema: {},
			handler_type: "shell",
			handler_code: 'echo "bye"',
		});
		expect(registry.has("to_remove")).toBe(true);

		const removed = registry.unregister("to_remove");
		expect(removed).toBe(true);
		expect(registry.has("to_remove")).toBe(false);

		const registry3 = new DynamicToolRegistry(db);
		expect(registry3.has("to_remove")).toBe(false);
	});

	test("unregister returns false for unknown tools", () => {
		const registry = new DynamicToolRegistry(db);
		expect(registry.unregister("nonexistent")).toBe(false);
	});

	test("rejects invalid tool names", () => {
		const registry = new DynamicToolRegistry(db);
		expect(() =>
			registry.register({
				name: "Invalid Name",
				description: "Bad name",
				input_schema: {},
				handler_type: "shell",
				handler_code: "echo x",
			}),
		).toThrow();
	});

	test("rejects inline handler type", () => {
		const registry = new DynamicToolRegistry(db);
		expect(() =>
			registry.register({
				name: "no_inline",
				description: "Inline is removed",
				input_schema: {},
				handler_type: "inline" as "shell",
			}),
		).toThrow();
	});

	test("requires handler_path for script type", () => {
		const registry = new DynamicToolRegistry(db);
		expect(() =>
			registry.register({
				name: "no_path",
				description: "Missing path",
				input_schema: {},
				handler_type: "script",
			}),
		).toThrow("handler_path is required");
	});

	test("requires handler_code for shell type", () => {
		const registry = new DynamicToolRegistry(db);
		expect(() =>
			registry.register({
				name: "no_shell_code",
				description: "Missing code",
				input_schema: {},
				handler_type: "shell",
			}),
		).toThrow("handler_code is required");
	});

	test("getAll returns all registered tools", () => {
		const freshDb = new Database(":memory:");
		runMigrations(freshDb);

		const registry = new DynamicToolRegistry(freshDb);
		registry.register({
			name: "tool_a",
			description: "Tool A",
			input_schema: {},
			handler_type: "shell",
			handler_code: "echo a",
		});
		registry.register({
			name: "tool_b",
			description: "Tool B",
			input_schema: {},
			handler_type: "shell",
			handler_code: "echo b",
		});

		const all = registry.getAll();
		expect(all).toHaveLength(2);
		expect(all.map((t) => t.name)).toEqual(["tool_a", "tool_b"]);

		freshDb.close();
	});

	test("registerAllOnServer tolerates a failing tool registration", () => {
		const freshDb = new Database(":memory:");
		runMigrations(freshDb);

		const registry = new DynamicToolRegistry(freshDb);
		registry.register({
			name: "good_tool",
			description: "Good",
			input_schema: {},
			handler_type: "shell",
			handler_code: "echo good",
		});
		registry.register({
			name: "bad_tool",
			description: "Bad",
			input_schema: {},
			handler_type: "shell",
			handler_code: "echo bad",
		});

		const attempted: string[] = [];
		const succeeded: string[] = [];
		const mockServer = {
			registerTool(name: string, _meta: unknown, _handler: unknown) {
				attempted.push(name);
				if (name === "bad_tool") {
					throw new Error("simulated schema failure");
				}
				succeeded.push(name);
			},
		};

		const origWarn = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map((a) => String(a)).join(" "));
		};

		try {
			expect(() => registry.registerAllOnServer(mockServer as never)).not.toThrow();
		} finally {
			console.warn = origWarn;
		}

		expect(attempted).toEqual(["good_tool", "bad_tool"]);
		expect(succeeded).toEqual(["good_tool"]);
		expect(warnings.some((w) => w.includes("bad_tool") && w.includes("simulated schema failure"))).toBe(true);

		freshDb.close();
	});

	test("upserts on duplicate name", () => {
		const freshDb = new Database(":memory:");
		runMigrations(freshDb);

		const registry = new DynamicToolRegistry(freshDb);
		registry.register({
			name: "update_me",
			description: "Version 1",
			input_schema: {},
			handler_type: "shell",
			handler_code: "echo v1",
		});

		registry.register({
			name: "update_me",
			description: "Version 2",
			input_schema: {},
			handler_type: "shell",
			handler_code: "echo v2",
		});

		expect(registry.count()).toBe(1);
		expect(registry.get("update_me")?.description).toBe("Version 2");

		freshDb.close();
	});
});

describe("Dynamic Tools via MCP Protocol", () => {
	let db: Database;
	let mcpServer: PhantomMcpServer;
	const adminToken = "dynamic-tools-test-token";
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = join(import.meta.dir, "tmp-dynamic-tools-test");
		if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

		const mcpConfig = {
			tokens: [{ name: "dynamic-tester", hash: hashTokenSync(adminToken), scopes: ["read", "operator", "admin"] }],
			rate_limit: { requests_per_minute: 100, burst: 50 },
		};
		writeFileSync(join(tmpDir, "mcp.yaml"), stringify(mcpConfig));

		db = new Database(":memory:");
		runMigrations(db);

		mcpServer = new PhantomMcpServer(
			{
				config: {
					name: "dynamic-test-phantom",
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
				evolution: null,
			},
			join(tmpDir, "mcp.yaml"),
		);
	});

	afterAll(async () => {
		await mcpServer.close();
		db.close();
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	});

	test("phantom_register_tool registers a new shell tool", async () => {
		const sessionId = await initSession(mcpServer, adminToken);
		const result = await callTool(mcpServer, adminToken, sessionId, "phantom_register_tool", {
			name: "phantom_hello",
			description: "A test tool that says hello",
			input_schema: { name: "string" },
			handler_type: "shell",
			handler_code: 'echo "Hello, $(echo $TOOL_INPUT | jq -r .name)!"',
		});

		expect(result.registered).toBe(true);
		expect(result.name).toBe("phantom_hello");
	});

	test("newly registered tool appears in tools/list on new session", async () => {
		const sessionId = await initSession(mcpServer, adminToken);
		const res = await mcpServer.handleRequest(
			mcpRequest(adminToken, { jsonrpc: "2.0", id: 10, method: "tools/list" }, sessionId),
		);
		const body = (await res.json()) as Record<string, unknown>;
		const result = body.result as { tools: Array<{ name: string }> };
		const toolNames = result.tools.map((t) => t.name);

		expect(toolNames).toContain("phantom_hello");
		expect(toolNames).toContain("phantom_register_tool");
		expect(toolNames).toContain("phantom_unregister_tool");
		expect(toolNames).toContain("phantom_list_dynamic_tools");
	});

	test("dynamically registered shell tool can be called", async () => {
		const sessionId = await initSession(mcpServer, adminToken);
		const res = await mcpServer.handleRequest(
			mcpRequest(
				adminToken,
				{
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "phantom_hello", arguments: { name: "Cheema" } },
				},
				sessionId,
			),
		);
		const body = (await res.json()) as Record<string, unknown>;
		const result = body.result as Record<string, unknown>;
		const content = result.content as Array<{ type: string; text: string }>;

		expect(content[0].text).toContain("Hello");
	});

	test("phantom_list_dynamic_tools returns registered tools", async () => {
		const sessionId = await initSession(mcpServer, adminToken);
		const result = await callTool(mcpServer, adminToken, sessionId, "phantom_list_dynamic_tools", {});

		expect(result.count).toBeGreaterThanOrEqual(1);
		const tools = result.tools as Array<{ name: string }>;
		expect(tools.some((t) => t.name === "phantom_hello")).toBe(true);
	});

	test("phantom_unregister_tool removes a tool", async () => {
		let sessionId = await initSession(mcpServer, adminToken);
		await callTool(mcpServer, adminToken, sessionId, "phantom_register_tool", {
			name: "temp_tool",
			description: "Temporary",
			input_schema: {},
			handler_type: "shell",
			handler_code: "echo temp",
		});

		sessionId = await initSession(mcpServer, adminToken);
		const result = await callTool(mcpServer, adminToken, sessionId, "phantom_unregister_tool", {
			name: "temp_tool",
		});

		expect(result.removed).toBe(true);
	});

	test("tool persists across registry reinstantiation", () => {
		const registry = mcpServer.getDynamicToolRegistry();
		expect(registry.has("phantom_hello")).toBe(true);
	});

	test("phantom_register_tool rejects invalid names", async () => {
		const sessionId = await initSession(mcpServer, adminToken);
		const result = await callTool(mcpServer, adminToken, sessionId, "phantom_register_tool", {
			name: "Invalid Name",
			description: "Bad",
			input_schema: {},
			handler_type: "shell",
			handler_code: "echo x",
		});

		expect(result.error).toBeDefined();
	});
});
