import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { DynamicToolRegistry } from "../../mcp/dynamic-tools.ts";
import {
	createGitHubToolServer,
	createInProcessToolServer,
	executeGhExec,
	redactTokensFromOutput,
	validateGhExecArgs,
	validateGhSubcommand,
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

describe("validateGhSubcommand", () => {
	describe("gh binary", () => {
		test("blocks gh auth", () => {
			const result = validateGhSubcommand("gh", ["auth", "token"]);
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.error).toContain("gh auth");
				expect(result.error).toContain("blocked");
			}
		});

		test("blocks gh auth status", () => {
			const result = validateGhSubcommand("gh", ["auth", "status"]);
			expect(result.valid).toBe(false);
		});

		test("blocks gh secret", () => {
			const result = validateGhSubcommand("gh", ["secret", "list"]);
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.error).toContain("gh secret");
			}
		});

		test("blocks gh config", () => {
			const result = validateGhSubcommand("gh", ["config", "get", "editor"]);
			expect(result.valid).toBe(false);
		});

		test("blocks gh ssh-key", () => {
			const result = validateGhSubcommand("gh", ["ssh-key", "list"]);
			expect(result.valid).toBe(false);
		});

		test("blocks gh gpg-key", () => {
			const result = validateGhSubcommand("gh", ["gpg-key", "list"]);
			expect(result.valid).toBe(false);
		});

		test("allows gh pr create", () => {
			const result = validateGhSubcommand("gh", ["pr", "create", "--title", "Test"]);
			expect(result.valid).toBe(true);
		});

		test("allows gh issue list", () => {
			const result = validateGhSubcommand("gh", ["issue", "list"]);
			expect(result.valid).toBe(true);
		});

		test("allows gh repo clone", () => {
			const result = validateGhSubcommand("gh", ["repo", "clone", "owner/repo"]);
			expect(result.valid).toBe(true);
		});

		test("allows gh api", () => {
			const result = validateGhSubcommand("gh", ["api", "/user"]);
			expect(result.valid).toBe(true);
		});
	});

	describe("git binary", () => {
		test("blocks git -c", () => {
			const result = validateGhSubcommand("git", ["-c", "alias.x=!env", "x"]);
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.error).toContain("git -c");
				expect(result.error).toContain("blocked");
			}
		});

		test("blocks git -c=", () => {
			const result = validateGhSubcommand("git", ["-c=alias.x=!env", "x"]);
			expect(result.valid).toBe(false);
		});

		test("blocks git --config=", () => {
			const result = validateGhSubcommand("git", ["--config=alias.x=!env", "x"]);
			expect(result.valid).toBe(false);
		});

		test("blocks git --config (space-separated)", () => {
			const result = validateGhSubcommand("git", ["--config", "alias.x=!env", "x"]);
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.error).toContain("--config");
			}
		});

		test("allows git push", () => {
			const result = validateGhSubcommand("git", ["push", "origin", "main"]);
			expect(result.valid).toBe(true);
		});

		test("allows git clone", () => {
			const result = validateGhSubcommand("git", ["clone", "https://github.com/owner/repo.git"]);
			expect(result.valid).toBe(true);
		});

		test("allows git config --local", () => {
			const result = validateGhSubcommand("git", ["config", "--local", "user.name", "Test"]);
			expect(result.valid).toBe(true);
		});

		test("allows git status", () => {
			const result = validateGhSubcommand("git", ["status"]);
			expect(result.valid).toBe(true);
		});
	});
});

describe("redactTokensFromOutput", () => {
	test("redacts known token exactly", () => {
		const token = "ghs_abc123def456ghi789jkl012mno345pqr678";
		const output = `Token: ${token}\nDone.`;
		const result = redactTokensFromOutput(output, token);
		expect(result).toBe("Token: [REDACTED]\nDone.");
		expect(result).not.toContain(token);
	});

	test("redacts ghs_ pattern tokens", () => {
		const output = "Found token: ghs_abcdefghij1234567890abcdefghij123456";
		const result = redactTokensFromOutput(output, "different_token");
		expect(result).toBe("Found token: [REDACTED]");
	});

	test("redacts gho_ pattern tokens", () => {
		const output = "OAuth: gho_abcdefghij1234567890abcdefghij123456";
		const result = redactTokensFromOutput(output, "");
		expect(result).toBe("OAuth: [REDACTED]");
	});

	test("redacts ghp_ pattern tokens", () => {
		const output = "PAT: ghp_abcdefghij1234567890abcdefghij123456";
		const result = redactTokensFromOutput(output, "");
		expect(result).toBe("PAT: [REDACTED]");
	});

	test("redacts ghu_ pattern tokens", () => {
		const output = "User token: ghu_abcdefghij1234567890abcdefghij123456";
		const result = redactTokensFromOutput(output, "");
		expect(result).toBe("User token: [REDACTED]");
	});

	test("redacts github_pat_ fine-grained tokens", () => {
		const token = `github_pat_${"a".repeat(60)}`;
		const output = `Fine-grained: ${token}`;
		const result = redactTokensFromOutput(output, "");
		expect(result).toBe("Fine-grained: [REDACTED]");
	});

	test("redacts multiple tokens in same output", () => {
		const token1 = "ghs_abcdefghij1234567890abcdefghij123456";
		const token2 = "ghp_zyxwvutsrq0987654321zyxwvutsrq098765";
		const output = `Token1: ${token1}\nToken2: ${token2}`;
		const result = redactTokensFromOutput(output, "");
		expect(result).toBe("Token1: [REDACTED]\nToken2: [REDACTED]");
	});

	test("leaves normal output unchanged", () => {
		const output = "Cloning into 'repo'...\nDone.";
		const result = redactTokensFromOutput(output, "some_token");
		expect(result).toBe(output);
	});

	test("handles empty string", () => {
		expect(redactTokensFromOutput("", "token")).toBe("");
	});

	test("handles output with gh prefix that is not a token", () => {
		const output = "ghs_short is too short to be a token";
		const result = redactTokensFromOutput(output, "");
		expect(result).toBe(output); // Too short, not redacted
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

	describe("blocked subcommands", () => {
		test("gh auth token is blocked before token getter is called", async () => {
			const result = await executeGhExec({ binary: "gh", args: ["auth", "token"] }, { tokenGetter: mockTokenGetter });
			expect(result.isError).toBe(true);
			const text = (result.content[0] as { type: string; text: string }).text;
			expect(text).toContain("gh auth");
			expect(text).toContain("blocked");
			// Token getter should NOT have been called
			expect(mockTokenGetter).not.toHaveBeenCalled();
		});

		test("gh secret list is blocked", async () => {
			const result = await executeGhExec({ binary: "gh", args: ["secret", "list"] }, { tokenGetter: mockTokenGetter });
			expect(result.isError).toBe(true);
			const text = (result.content[0] as { type: string; text: string }).text;
			expect(text).toContain("gh secret");
		});

		test("git -c alias.x=!env x is blocked", async () => {
			const result = await executeGhExec(
				{ binary: "git", args: ["-c", "alias.x=!env", "x"] },
				{ tokenGetter: mockTokenGetter },
			);
			expect(result.isError).toBe(true);
			const text = (result.content[0] as { type: string; text: string }).text;
			expect(text).toContain("git -c");
		});
	});

	describe("concurrent drain and limits", () => {
		test("handles large stderr without deadlock", async () => {
			// Git status with verbose output writes to both stdout and stderr
			const result = await executeGhExec(
				{ binary: "git", args: ["status", "--porcelain"] },
				{ tokenGetter: mockTokenGetter },
			);
			// Should complete without hanging
			expect(result.content).toBeDefined();
		});

		test("redacts tokens in output even from concurrent drain", async () => {
			const result = await executeGhExec({ binary: "git", args: ["--version"] }, { tokenGetter: mockTokenGetter });
			expect(result.isError).toBeFalsy();
			const text = (result.content[0] as { type: string; text: string }).text;
			// Token should never appear in output
			expect(text).not.toContain("ghs_mock_token_12345");
		});
	});
});
