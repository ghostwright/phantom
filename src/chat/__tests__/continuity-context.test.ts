import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { buildChatContinuityContext } from "../continuity-context.ts";
import { ChatEventLog } from "../event-log.ts";
import { ChatSessionStore } from "../session-store.ts";

let db: Database;
let eventLog: ChatEventLog;
let sessionStore: ChatSessionStore;

beforeEach(() => {
	db = new Database(":memory:");
	for (const sql of MIGRATIONS) {
		db.run(sql);
	}
	eventLog = new ChatEventLog(db);
	sessionStore = new ChatSessionStore(db);
});

afterEach(() => {
	db.close();
});

describe("buildChatContinuityContext", () => {
	test("summarizes created page artifacts from the durable stream log", () => {
		const session = sessionStore.create();
		eventLog.append(session.id, null, 1, "message.tool_call_start", {
			event: "message.tool_call_start",
			tool_call_id: "tool-1",
			tool_name: "phantom_create_page",
			message_id: "assistant-1",
			parent_tool_use_id: null,
			is_mcp: true,
		});
		eventLog.append(session.id, null, 2, "message.tool_call_input_end", {
			event: "message.tool_call_input_end",
			tool_call_id: "tool-1",
			input: {
				path: "muhammad-ahmed-cheema.html",
				title: "Muhammad Ahmed Cheema Profile",
			},
		});
		eventLog.append(session.id, null, 3, "message.tool_call_result", {
			event: "message.tool_call_result",
			tool_call_id: "tool-1",
			tool_name: "phantom_create_page",
			status: "success",
			output: JSON.stringify({
				path: "muhammad-ahmed-cheema.html",
				url: "http://127.0.0.1:3112/ui/muhammad-ahmed-cheema.html",
				size: 12345,
			}),
		});

		const context = buildChatContinuityContext({ sessionId: session.id, eventLog });

		expect(context).toContain(`Current Phantom chat session id: ${session.id}`);
		expect(context).toContain("phantom_chat_transcript_search");
		expect(context).toContain("User-visible page artifacts");
		expect(context).toContain("Muhammad Ahmed Cheema Profile");
		expect(context).toContain("http://127.0.0.1:3112/ui/muhammad-ahmed-cheema.html");
		expect(context).toContain("muhammad-ahmed-cheema.html");
		expect(context).not.toContain("/ui/login");
	});

	test("skips login links and keeps recent compact checkpoints", () => {
		const session = sessionStore.create();
		eventLog.append(session.id, null, 1, "session.compact_boundary", {
			event: "session.compact_boundary",
			trigger: "auto",
			pre_tokens: 1434337,
		});
		eventLog.append(session.id, null, 2, "message.tool_call_result", {
			event: "message.tool_call_result",
			tool_call_id: "tool-login",
			tool_name: "phantom_generate_login",
			status: "success",
			output: JSON.stringify({
				magicLink: "http://127.0.0.1:3112/ui/login?magic=secret",
			}),
		});

		const context = buildChatContinuityContext({ sessionId: session.id, eventLog });

		expect(context).toContain("auto compaction at stream seq 1 before about 1,434,337 tokens.");
		expect(context).toContain("Authentication links");
		expect(context).not.toContain("magic=secret");
	});

	test("uses the latest stream events when the full event log is larger than the scan limit", () => {
		const session = sessionStore.create();
		for (let seq = 1; seq <= 12; seq++) {
			eventLog.append(session.id, null, seq, "session.status", {
				event: "session.status",
				status: "working",
				permission_mode: "bypassPermissions",
			});
		}
		eventLog.append(session.id, null, 13, "session.compact_boundary", {
			event: "session.compact_boundary",
			trigger: "auto",
			pre_tokens: 500000,
		});

		const context = buildChatContinuityContext({ sessionId: session.id, eventLog, limit: 3 });

		expect(context).toContain("stream seq 13");
		expect(context).toContain("500,000");
	});

	test("renders transcript recovery instructions even without artifacts or compaction", () => {
		const session = sessionStore.create();

		const context = buildChatContinuityContext({ sessionId: session.id, eventLog });

		expect(context).toContain(`Current Phantom chat session id: ${session.id}`);
		expect(context).toContain("phantom_chat_transcript_search");
		expect(context).toContain("Authentication links");
	});
});
