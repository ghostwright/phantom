import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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

	test("keeps direct Agent SDK imports isolated to the boundary module", () => {
		const offenders = listTypeScriptFiles(SRC_ROOT)
			.map((path) => ({ path, rel: relative(SRC_ROOT, path), source: readFileSync(path, "utf-8") }))
			.filter(({ rel }) => rel !== BOUNDARY_FILE)
			.filter(({ source }) => /from\s+["']@anthropic-ai\/claude-agent-sdk["']/.test(source))
			.map(({ rel }) => rel);

		expect(offenders).toEqual([]);
	});
});
