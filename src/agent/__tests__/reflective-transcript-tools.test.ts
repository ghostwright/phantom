import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { createReflectiveToolServer } from "../in-process-reflective-tools.ts";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
};

type RegisteredTool = {
	handler: (input: unknown) => Promise<ToolResult> | ToolResult;
};

let db: Database;

function registeredTools(): Record<string, RegisteredTool> {
	const server = createReflectiveToolServer(null, db, { currentChatSessionId: "chat-1" });
	const instance = server.instance as unknown as { _registeredTools: Record<string, RegisteredTool> };
	return instance._registeredTools;
}

function insertMessage(input: { id: string; seq: number; role: "user" | "assistant"; content: unknown }): void {
	db.run(
		`INSERT INTO chat_messages (id, session_id, seq, role, content_json)
		 VALUES (?, 'chat-1', ?, ?, ?)`,
		[input.id, input.seq, input.role, JSON.stringify(input.content)],
	);
}

beforeEach(() => {
	db = new Database(":memory:");
	for (const sql of MIGRATIONS) {
		db.run(sql);
	}
	db.run("INSERT INTO chat_sessions (id) VALUES ('chat-1')");
});

afterEach(() => {
	db.close();
});

describe("phantom-reflective transcript tools", () => {
	test("registers transcript search alongside memory and session tools", () => {
		const tools = registeredTools();

		expect(tools.phantom_memory_search).toBeDefined();
		expect(tools.phantom_list_sessions).toBeDefined();
		expect(tools.phantom_chat_transcript_search).toBeDefined();
	});

	test("searches durable chat transcript with safe redaction", async () => {
		insertMessage({ id: "m1", seq: 1, role: "user", content: "Remember alpha marker." });
		insertMessage({
			id: "m2",
			seq: 2,
			role: "assistant",
			content: "alpha result with http://127.0.0.1:3112/ui/login?magic=secret-token",
		});

		const tool = registeredTools().phantom_chat_transcript_search;
		const result = await tool.handler({ session_id: "chat-1", query: "alpha", limit: 10 });
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
			count: number;
			results: Array<{ seq: number; citation: string; snippet: string }>;
		};

		expect(parsed.count).toBe(2);
		expect(parsed.results.map((row) => row.seq)).toEqual([2, 1]);
		expect(parsed.results[0]?.citation).toBe("chat:chat-1#msg:2");
		expect(parsed.results[0]?.snippet).toContain("/ui/login?magic=[REDACTED]");
		expect(parsed.results[0]?.snippet).not.toContain("secret-token");
	});

	test("lists recent transcript entries when query is omitted", async () => {
		insertMessage({ id: "m1", seq: 1, role: "user", content: "first" });
		insertMessage({ id: "m2", seq: 2, role: "assistant", content: "second" });
		insertMessage({ id: "m3", seq: 3, role: "user", content: "third" });

		const tool = registeredTools().phantom_chat_transcript_search;
		const result = await tool.handler({ session_id: "chat-1", limit: 2 });
		const parsed = JSON.parse(result.content[0]?.text ?? "{}") as { results: Array<{ seq: number }> };

		expect(parsed.results.map((row) => row.seq)).toEqual([3, 2]);
	});

	test("rejects transcript search outside the bound chat session", async () => {
		insertMessage({ id: "m1", seq: 1, role: "user", content: "first" });

		const tool = registeredTools().phantom_chat_transcript_search;
		const result = await tool.handler({ session_id: "chat-2", limit: 1 });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("current Phantom chat session");
	});

	test("rejects transcript search when no chat session is bound", async () => {
		const server = createReflectiveToolServer(null, db);
		const instance = server.instance as unknown as { _registeredTools: Record<string, RegisteredTool> };
		const tool = instance._registeredTools.phantom_chat_transcript_search;
		const result = await tool.handler({ session_id: "chat-1", limit: 1 });

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("bound Phantom web chat run");
	});
});
