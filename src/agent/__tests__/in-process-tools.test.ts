import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { DynamicToolRegistry } from "../../mcp/dynamic-tools.ts";
import {
	createGitHubToolServer,
	createInProcessToolServer,
	executeGhExec,
	validateGhExecArgs,
} from "../in-process-tools.ts";

// Mock token getter for testing - injected via options, not module mock
const mockTokenGetter = mock(() => Promise.resolve("ghs_mock_token_12345"));

describe("createInProcessToolServer", () => {
	let db: Database;
	let registry: DynamicToolRegistry;

	beforeAll(() => {
		db = new Database(":memory:");
		db.run(
			`CREATE TABLE IF NOT EXISTS dynamic_tools (
				name TEXT PRIMARY KEY,
				description TEXT NOT NULL,
				input_schema TEXT NOT NULL,
				handler_type TEXT NOT NULL DEFAULT 'inline',
				handler_code TEXT,
				handler_path TEXT,
				registered_at TEXT NOT NULL DEFAULT (datetime('now')),
				registered_by TEXT
			)`,
		);
		registry = new DynamicToolRegistry(db);
	});

	afterAll(() => {
		db.close();
	});

	test("returns a valid SDK MCP server config", () => {
		const server = createInProcessToolServer(registry);
		expect(server).toBeDefined();
		expect(server.type).toBe("sdk");
		expect(server.name).toBe("phantom-dynamic-tools");
		expect(server.instance).toBeDefined();
	});

	test("shares the same registry instance", () => {
		registry.register({
			name: "shared_test",
			description: "Test shared registry",
			input_schema: {},
			handler_type: "shell",
			handler_code: "echo shared",
		});

		expect(registry.has("shared_test")).toBe(true);

		// Clean up
		registry.unregister("shared_test");
	});

	test("server has correct type for SDK mcpServers config", () => {
		const server = createInProcessToolServer(registry);
		// Verify it can be used in a Record<string, McpServerConfig>
		const mcpServers = { "phantom-dynamic-tools": server };
		expect(mcpServers["phantom-dynamic-tools"].type).toBe("sdk");
		expect(mcpServers["phantom-dynamic-tools"].name).toBe("phantom-dynamic-tools");
	});
});

describe("createGitHubToolServer", () => {
	test("returns a valid SDK MCP server config", () => {
		const server = createGitHubToolServer();
		expect(server).toBeDefined();
		expect(server.type).toBe("sdk");
		expect(server.name).toBe("phantom-github");
	});

	test("server has correct type for SDK mcpServers config", () => {
		const server = createGitHubToolServer();
		const mcpServers = { "phantom-github": server };
		expect(mcpServers["phantom-github"].type).toBe("sdk");
	});
});

describe("validateGhExecArgs", () => {
	test("accepts clean args", () => {
		const result = validateGhExecArgs(["status", "--short"]);
		expect(result.valid).toBe(true);
	});

	test("rejects semicolon", () => {
		const result = validateGhExecArgs(["status", ";", "rm", "-rf"]);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.error).toContain("shell metacharacter");
		}
	});

	test("rejects pipe", () => {
		const result = validateGhExecArgs(["status", "|", "cat"]);
		expect(result.valid).toBe(false);
	});

	test("rejects ampersand", () => {
		const result = validateGhExecArgs(["status", "&", "bg"]);
		expect(result.valid).toBe(false);
	});

	test("rejects command substitution", () => {
		const result = validateGhExecArgs(["status", "$(whoami)"]);
		expect(result.valid).toBe(false);
	});

	test("rejects backticks", () => {
		const result = validateGhExecArgs(["status", "`id`"]);
		expect(result.valid).toBe(false);
	});

	test("rejects redirects", () => {
		expect(validateGhExecArgs([">", "/tmp/pwned"]).valid).toBe(false);
		expect(validateGhExecArgs(["<", "/etc/passwd"]).valid).toBe(false);
	});
});

describe("executeGhExec", () => {
	beforeEach(() => {
		mockTokenGetter.mockClear();
		mockTokenGetter.mockImplementation(() => Promise.resolve("ghs_mock_token_12345"));
	});

	afterEach(() => {
		// Restore env vars
		if (Reflect.has(process.env, "ANTHROPIC_API_KEY_BACKUP")) {
			process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY_BACKUP;
			Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY_BACKUP");
		}
	});

	test("gh --version returns stdout", async () => {
		const result = await executeGhExec({ binary: "gh", args: ["--version"] }, { tokenGetter: mockTokenGetter });
		expect(result.isError).toBeFalsy();
		const text = (result.content[0] as { type: string; text: string }).text;
		const parsed = JSON.parse(text);
		expect(parsed.exitCode).toBe(0);
		expect(parsed.stdout).toContain("gh version");
	});

	test("git --version returns stdout", async () => {
		const result = await executeGhExec({ binary: "git", args: ["--version"] }, { tokenGetter: mockTokenGetter });
		expect(result.isError).toBeFalsy();
		const text = (result.content[0] as { type: string; text: string }).text;
		const parsed = JSON.parse(text);
		expect(parsed.exitCode).toBe(0);
		expect(parsed.stdout).toContain("git version");
	});

	test("calls token getter", async () => {
		await executeGhExec({ binary: "git", args: ["version"] }, { tokenGetter: mockTokenGetter });
		expect(mockTokenGetter).toHaveBeenCalled();
	});

	test("result does NOT include API keys from parent env", async () => {
		// Set a test API key
		process.env.ANTHROPIC_API_KEY_BACKUP = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-should-not-leak";

		const result = await executeGhExec({ binary: "git", args: ["--version"] }, { tokenGetter: mockTokenGetter });
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).not.toContain("sk-ant-test-should-not-leak");
	});

	test("result does NOT contain GH_TOKEN value", async () => {
		const result = await executeGhExec({ binary: "git", args: ["--version"] }, { tokenGetter: mockTokenGetter });
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).not.toContain("ghs_mock_token_12345");
	});

	test("non-zero exit returns isError with stderr", async () => {
		const result = await executeGhExec(
			{ binary: "git", args: ["not-a-real-command"] },
			{ tokenGetter: mockTokenGetter },
		);
		expect(result.isError).toBe(true);
		const text = (result.content[0] as { type: string; text: string }).text;
		const parsed = JSON.parse(text);
		expect(parsed.exitCode).not.toBe(0);
		expect(parsed.stderr).toBeDefined();
	});

	test("rejects shell metacharacters in args", async () => {
		const dangerous = [
			["status", ";", "rm", "-rf", "/"],
			["status", "|", "cat", "/etc/passwd"],
			["status", "&", "malicious"],
			["status", "$(whoami)"],
			["status", "`whoami`"],
		];

		for (const args of dangerous) {
			// Shell metacharacter check happens before token getter is called
			const result = await executeGhExec({ binary: "git", args }, { tokenGetter: mockTokenGetter });
			expect(result.isError).toBe(true);
			const text = (result.content[0] as { type: string; text: string }).text;
			expect(text).toContain("shell metacharacter");
		}
	});

	test("args passed as array prevents shell injection", async () => {
		// This arg looks like it could be dangerous but is passed as array elements
		const result = await executeGhExec(
			{ binary: "git", args: ["log", "--oneline", "-n", "0"] },
			{ tokenGetter: mockTokenGetter },
		);
		expect(result.isError).toBeFalsy();
	});
});
