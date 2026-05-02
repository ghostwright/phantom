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

	test("concurrent drain: large stderr before stdout does not deadlock", async () => {
		// Regression test for pipe-buffer deadlock. Write 200 KB to stderr
		// (well beyond the 64 KB pipe buffer), then print to stdout and exit.
		// Under the old sequential-drain code this hangs forever.
		const tool: DynamicToolDef = {
			name: "test_pipe_deadlock",
			description: "test",
			inputSchema: {},
			handlerType: "shell",
			handlerCode: 'head -c 204800 /dev/urandom | base64 >&2; echo "done"',
		};

		const start = Date.now();
		const result = await executeDynamicHandler(tool, {});
		const elapsed = Date.now() - start;

		expect(result.isError).toBeFalsy();
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toBe("done");
		// Should complete in well under 5 seconds. A deadlock would hit the
		// test runner timeout instead.
		expect(elapsed).toBeLessThan(5000);
	});

	test("timeout kills a hung handler", async () => {
		const origTimeout = process.env.PHANTOM_DYNAMIC_HANDLER_TIMEOUT_MS;
		process.env.PHANTOM_DYNAMIC_HANDLER_TIMEOUT_MS = "500";
		try {
			const tool: DynamicToolDef = {
				name: "test_hang",
				description: "test",
				inputSchema: {},
				handlerType: "shell",
				handlerCode: "sleep 10",
			};

			const start = Date.now();
			const result = await executeDynamicHandler(tool, {});
			const elapsed = Date.now() - start;

			expect(result.isError).toBe(true);
			const text = (result.content[0] as { type: string; text: string }).text;
			expect(text).toContain("timed out");
			// 500ms timeout + 2s grace + slack. Should be well under 10s (the sleep).
			expect(elapsed).toBeLessThan(5000);
		} finally {
			if (origTimeout !== undefined) {
				process.env.PHANTOM_DYNAMIC_HANDLER_TIMEOUT_MS = origTimeout;
			} else {
				// `= undefined` would coerce to the string "undefined" on process.env;
				// Reflect.deleteProperty actually removes the key so later tests see it as unset.
				// (Matches the pattern acknowledged by the maintainer in #5.)
				Reflect.deleteProperty(process.env, "PHANTOM_DYNAMIC_HANDLER_TIMEOUT_MS");
			}
		}
	});

	test("output cap truncates runaway stdout", async () => {
		const origCap = process.env.PHANTOM_DYNAMIC_HANDLER_MAX_OUTPUT_BYTES;
		process.env.PHANTOM_DYNAMIC_HANDLER_MAX_OUTPUT_BYTES = "10000";
		try {
			const tool: DynamicToolDef = {
				name: "test_runaway",
				description: "test",
				inputSchema: {},
				handlerType: "shell",
				// Emit ~270 KB of base64 to stdout, far exceeding the 10 KB cap.
				handlerCode: "head -c 200000 /dev/urandom | base64",
			};

			const result = await executeDynamicHandler(tool, {});

			expect(result.isError).toBeFalsy();
			const text = (result.content[0] as { type: string; text: string }).text;
			expect(text).toContain("Output truncated");
			// Captured bytes ≤ cap + truncation notice (~50 chars). Trim happens
			// after the truncation marker was appended, so just assert it's
			// bounded well below the full output size.
			expect(text.length).toBeLessThan(11000);
		} finally {
			if (origCap !== undefined) {
				process.env.PHANTOM_DYNAMIC_HANDLER_MAX_OUTPUT_BYTES = origCap;
			} else {
				// See note on PHANTOM_DYNAMIC_HANDLER_TIMEOUT_MS above.
				Reflect.deleteProperty(process.env, "PHANTOM_DYNAMIC_HANDLER_MAX_OUTPUT_BYTES");
			}
		}
	});

	test("non-zero exit surfaces stderr and exit code in error message", async () => {
		// The concurrency claim (stdout and stderr drained in parallel) is
		// already proven by the pipe-deadlock regression test above. This test
		// guards the non-zero exit path: the error message must include the
		// captured stderr and the exit code so the agent has actionable signal.
		const tool: DynamicToolDef = {
			name: "test_mixed_streams",
			description: "test",
			inputSchema: {},
			handlerType: "shell",
			handlerCode: 'echo "stdout-marker"; echo "stderr-marker" >&2; exit 2',
		};

		const result = await executeDynamicHandler(tool, {});
		expect(result.isError).toBe(true);
		const text = (result.content[0] as { type: string; text: string }).text;
		expect(text).toContain("stderr-marker");
		expect(text).toContain("exit 2");
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
