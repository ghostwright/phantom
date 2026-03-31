import { describe, expect, test } from "bun:test";
import { buildSafeEnv, executeDynamicHandler } from "../dynamic-handlers.ts";
import type { DynamicToolDef } from "../dynamic-tools.ts";

describe("buildSafeEnv", () => {
	test("includes only safe environment variables", () => {
		const env = buildSafeEnv({ hello: "world" });
		expect(env.PATH).toBeDefined();
		expect(env.HOME).toBeDefined();
		expect(env.LANG).toBeDefined();
		expect(env.TERM).toBeDefined();
		expect(env.TOOL_INPUT).toBe('{"hello":"world"}');
		expect(Object.keys(env)).toHaveLength(5);
	});

	test("does not include ANTHROPIC_API_KEY", () => {
		const origKey = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-should-not-leak";
		try {
			const env = buildSafeEnv({});
			expect(env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(JSON.stringify(env)).not.toContain("sk-ant-test-key-should-not-leak");
		} finally {
			if (origKey !== undefined) {
				process.env.ANTHROPIC_API_KEY = origKey;
			} else {
				process.env.ANTHROPIC_API_KEY = undefined;
			}
		}
	});

	test("does not include SLACK_BOT_TOKEN", () => {
		const origToken = process.env.SLACK_BOT_TOKEN;
		process.env.SLACK_BOT_TOKEN = "xoxb-test-token-should-not-leak";
		try {
			const env = buildSafeEnv({});
			expect(env.SLACK_BOT_TOKEN).toBeUndefined();
			expect(JSON.stringify(env)).not.toContain("xoxb-test-token-should-not-leak");
		} finally {
			if (origToken !== undefined) {
				process.env.SLACK_BOT_TOKEN = origToken;
			} else {
				process.env.SLACK_BOT_TOKEN = undefined;
			}
		}
	});
});

describe("executeDynamicHandler", () => {
	test("rejects unknown handler type with error", async () => {
		const tool = {
			name: "test_bad_type",
			description: "test",
			inputSchema: {},
			handlerType: "inline" as "script",
			handlerCode: "return 'pwned'",
		} as DynamicToolDef;

		const result = await executeDynamicHandler(tool, {});
		expect(result.isError).toBe(true);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("Unknown handler type");
		expect(text).toContain("Only");
	});

	test("shell handler does not expose API keys", async () => {
		const tool: DynamicToolDef = {
			name: "test_env_leak",
			description: "test",
			inputSchema: {},
			handlerType: "shell",
			handlerCode: "echo $ANTHROPIC_API_KEY",
		};

		const origKey = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-should-not-leak";
		try {
			const result = await executeDynamicHandler(tool, {});
			const text = (result.content[0] as { type: string; text: string }).text;
			expect(text).not.toContain("sk-ant-test-key-should-not-leak");
		} finally {
			if (origKey !== undefined) {
				process.env.ANTHROPIC_API_KEY = origKey;
			} else {
				process.env.ANTHROPIC_API_KEY = undefined;
			}
		}
	});

	test("shell handler receives TOOL_INPUT env var", async () => {
		const tool: DynamicToolDef = {
			name: "test_input_env",
			description: "test",
			inputSchema: {},
			handlerType: "shell",
			handlerCode: 'echo "$TOOL_INPUT"',
		};

		const result = await executeDynamicHandler(tool, { hello: "world" });
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain('"hello":"world"');
	});

	test("shell handler returns error for non-zero exit", async () => {
		const tool: DynamicToolDef = {
			name: "test_fail",
			description: "test",
			inputSchema: {},
			handlerType: "shell",
			handlerCode: "exit 1",
		};

		const result = await executeDynamicHandler(tool, {});
		expect(result.isError).toBe(true);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("Shell error");
	});

	test("script handler returns error for missing file", async () => {
		const tool: DynamicToolDef = {
			name: "test_missing_script",
			description: "test",
			inputSchema: {},
			handlerType: "script",
			handlerPath: "/tmp/phantom-nonexistent-script.ts",
		};

		const result = await executeDynamicHandler(tool, {});
		expect(result.isError).toBe(true);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("Script not found");
	});

	test("script handler does not expose API keys", async () => {
		const tmpFile = "/tmp/phantom-test-env-leak.ts";
		await Bun.write(tmpFile, 'console.log(process.env.ANTHROPIC_API_KEY ?? "NOT_SET")');

		const tool: DynamicToolDef = {
			name: "test_script_env_leak",
			description: "test",
			inputSchema: {},
			handlerType: "script",
			handlerPath: tmpFile,
		};

		const origKey = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-should-not-leak";
		try {
			const result = await executeDynamicHandler(tool, {});
			const text = (result.content[0] as { type: string; text: string }).text;
			expect(text).not.toContain("sk-ant-test-key-should-not-leak");
			expect(text).toBe("NOT_SET");
		} finally {
			if (origKey !== undefined) {
				process.env.ANTHROPIC_API_KEY = origKey;
			} else {
				process.env.ANTHROPIC_API_KEY = undefined;
			}
		}
	});

	test("script handler receives TOOL_INPUT via env", async () => {
		const tmpFile = "/tmp/phantom-test-tool-input.ts";
		await Bun.write(tmpFile, "console.log(process.env.TOOL_INPUT)");

		const tool: DynamicToolDef = {
			name: "test_script_input",
			description: "test",
			inputSchema: {},
			handlerType: "script",
			handlerPath: tmpFile,
		};

		const result = await executeDynamicHandler(tool, { key: "value" });
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain('"key":"value"');
	});
});
