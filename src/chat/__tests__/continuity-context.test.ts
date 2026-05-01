import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { buildChatContinuityContext } from "../continuity-context.ts";
import { ChatEventLog } from "../event-log.ts";
import { ChatRunTimelineStore } from "../run-timeline.ts";
import { ChatSessionStore } from "../session-store.ts";

let db: Database;
let eventLog: ChatEventLog;
let sessionStore: ChatSessionStore;
let timelineStore: ChatRunTimelineStore;

beforeEach(() => {
	db = new Database(":memory:");
	for (const sql of MIGRATIONS) {
		db.run(sql);
	}
	eventLog = new ChatEventLog(db);
	sessionStore = new ChatSessionStore(db);
	timelineStore = new ChatRunTimelineStore(db);
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
			tool_name: "mcp__phantom-web-ui__phantom_create_page",
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
			tool_name: "mcp__phantom-web-ui__phantom_create_page",
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
		expect(context).toContain("via phantom_create_page");
		expect(context).not.toContain("/ui/login");
	});

	test("extracts relative page links from MCP-qualified preview output text", () => {
		const session = sessionStore.create();
		eventLog.append(session.id, null, 1, "message.tool_call_input_end", {
			event: "message.tool_call_input_end",
			tool_call_id: "tool-preview",
			input: {
				path: "reports/weekly.html",
			},
		});
		eventLog.append(session.id, null, 2, "message.tool_call_result", {
			event: "message.tool_call_result",
			tool_call_id: "tool-preview",
			tool_name: "mcp__phantom-preview__phantom_preview_page",
			status: "success",
			output: "Previewed /ui/reports/weekly.html.",
		});

		const context = buildChatContinuityContext({ sessionId: session.id, eventLog });

		expect(context).toContain("reports/weekly.html");
		expect(context).toContain("/ui/reports/weekly.html");
		expect(context).toContain("via phantom_preview_page");
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

	test("uses persisted timeline artifacts after stream events are unavailable", () => {
		const session = sessionStore.create();
		db.run(
			`INSERT INTO chat_messages (id, session_id, seq, role, content_json)
			 VALUES ('user-1', ?, 1, 'user', '"create page"')`,
			[session.id],
		);
		timelineStore.upsert({
			id: "run-1",
			sessionId: session.id,
			userMessageId: "user-1",
			startSeq: 1,
			status: "completed",
			startedAt: "2026-05-01T00:00:00.000Z",
			completedAt: "2026-05-01T00:00:03.000Z",
			currentLabel: "Completed.",
			summary: {
				schemaVersion: 1,
				status: "completed",
				startSeq: 1,
				endSeq: 4,
				startedAt: "2026-05-01T00:00:00.000Z",
				completedAt: "2026-05-01T00:00:03.000Z",
				currentLabel: "Completed.",
				artifacts: [
					{
						id: "page:/ui/reports/weekly.html",
						type: "page",
						title: "Weekly Report",
						url: "/ui/reports/weekly.html",
						path: "reports/weekly.html",
						sizeBytes: 8842,
						sourceToolName: "phantom_create_page",
					},
				],
				tools: [],
				subagents: [],
				errors: [],
			},
		});

		const context = buildChatContinuityContext({ sessionId: session.id, eventLog, timelineStore });

		expect(context).toContain("Weekly Report");
		expect(context).toContain("/ui/reports/weekly.html");
		expect(context).toContain("reports/weekly.html");
		expect(context).toContain("via phantom_create_page");
	});
});
