import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AGENT_SDK_MODULE_ENV } from "../agent-sdk-loader.ts";
import {
	type AgentSdkQueryParams,
	type Query,
	type SDKMessage,
	__setAgentSdkQueryForTests,
	createSdkMcpServer,
	query,
	tool,
} from "../agent-sdk.ts";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BOUNDARY_FILE = "agent/agent-sdk.ts";

function listTypeScriptFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...listTypeScriptFiles(path));
		} else if (entry.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}

function queryFromMessages(messages: readonly SDKMessage[]): Query {
	async function* iterator(): AsyncGenerator<SDKMessage, void> {
		for (const message of messages) {
			yield message;
		}
	}

	return iterator() as Query;
}

describe("Agent SDK boundary", () => {
	test("exposes the runtime symbols Phantom needs", () => {
		expect(typeof query).toBe("function");
		expect(typeof createSdkMcpServer).toBe("function");
		expect(typeof tool).toBe("function");
	});

	test("supports a scoped query override for compatibility harnesses", async () => {
		const calls: AgentSdkQueryParams[] = [];
		const fakeMessage: SDKMessage = {
			type: "system",
			subtype: "init",
			session_id: "fake-session",
			mcp_servers: [],
			tools: [],
			model: "test-model",
			permissionMode: "bypassPermissions",
			slash_commands: [],
			skills: [],
			plugins: [],
			apiKeySource: "user",
			claude_code_version: "test",
			output_style: "default",
			uuid: "00000000-0000-4000-8000-000000000000",
			cwd: "/tmp",
			agents: [],
		};

		__setAgentSdkQueryForTests((params) => {
			calls.push(params);
			return queryFromMessages([fakeMessage]);
		});

		try {
			const messages: SDKMessage[] = [];
			for await (const message of query({ prompt: "hello" })) {
				messages.push(message);
			}

			expect(calls).toHaveLength(1);
			expect(calls[0]?.prompt).toBe("hello");
			expect(messages).toEqual([fakeMessage]);
		} finally {
			__setAgentSdkQueryForTests(null);
		}
	});

	test("resets scoped query overrides to the env-loaded runtime", () => {
		const dir = mkdtempSync(join(tmpdir(), "phantom-agent-sdk-"));
		try {
			const fakeModule = join(dir, "fake-sdk.mjs");
			writeFileSync(
				fakeModule,
				`
					export function query() {
						return (async function* () {
							yield { type: "result", subtype: "success", result: "env-runtime" };
						})();
					}
				`,
			);

			const script = `
				const { query, __setAgentSdkQueryForTests } = await import(${JSON.stringify(pathToFileURL(join(SRC_ROOT, BOUNDARY_FILE)).href)});
				function overrideQuery() {
					return (async function* () {
						yield { type: "result", subtype: "success", result: "override-runtime" };
					})();
				}
				__setAgentSdkQueryForTests(overrideQuery);
				const overrideMessages = [];
				for await (const message of query({ prompt: "override" })) overrideMessages.push(message);
				__setAgentSdkQueryForTests(null);
				const resetMessages = [];
				for await (const message of query({ prompt: "reset" })) resetMessages.push(message);
				console.log(JSON.stringify({
					override: overrideMessages.map((message) => message.result),
					reset: resetMessages.map((message) => message.result),
				}));
			`;
			const result = spawnSync(process.execPath, ["-e", script], {
				cwd: join(SRC_ROOT, ".."),
				encoding: "utf8",
				env: {
					...process.env,
					[AGENT_SDK_MODULE_ENV]: pathToFileURL(fakeModule).href,
				},
			});

			if (result.status !== 0) {
				throw new Error(result.stderr || result.stdout);
			}
			const output = JSON.parse(result.stdout.trim()) as { override: string[]; reset: string[] };
			expect(output).toEqual({ override: ["override-runtime"], reset: ["env-runtime"] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("keeps direct Agent SDK imports isolated to the boundary module", () => {
		const packagePattern = "@anthropic-ai/claude-agent-sdk(?:/[^\"'`\\s)]*)?";
		const directAgentSdkReference = new RegExp(
			[
				`from\\s+["']${packagePattern}["']`,
				`import\\s+["']${packagePattern}["']`,
				`import\\s*\\(\\s*["']${packagePattern}["']\\s*\\)`,
				`(?:require|Bun\\.require|module\\.require)\\s*\\(\\s*["']${packagePattern}["']\\s*\\)`,
				`createRequire\\s*\\([^)]*\\)\\s*\\(\\s*["']${packagePattern}["']\\s*\\)`,
			].join("|"),
		);
		const offenders = listTypeScriptFiles(SRC_ROOT)
			.map((path) => ({ path, rel: relative(SRC_ROOT, path), source: readFileSync(path, "utf-8") }))
			.filter(({ rel }) => rel !== BOUNDARY_FILE)
			.filter(({ source }) => directAgentSdkReference.test(source))
			.map(({ rel }) => rel);

		expect(offenders).toEqual([]);
	});
});
