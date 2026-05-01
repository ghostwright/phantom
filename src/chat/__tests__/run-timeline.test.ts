import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { ChatRunTimelineStore, DurableRunTimelineBuilder } from "../run-timeline.ts";
import type { ChatWireFrame } from "../types.ts";

let db: Database;

function startBuilder(): DurableRunTimelineBuilder {
	const builder = DurableRunTimelineBuilder.start({
		sessionId: "sess-1",
		userMessageId: "user-1",
		startSeq: 1,
		startedAt: "2026-04-30T00:00:00.000Z",
	});
	builder.apply(
		{
			event: "user.message",
			message_id: "user-1",
			text: "hello",
			attachments: [],
			sent_at: "2026-04-30T00:00:00.000Z",
			source_tab_id: "tab-1",
		},
		1,
	);
	return builder;
}

beforeEach(() => {
	db = new Database(":memory:");
	for (const sql of MIGRATIONS) {
		db.run(sql);
	}
	db.run("INSERT INTO chat_sessions (id) VALUES ('sess-1')");
	db.run(
		`INSERT INTO chat_messages (id, session_id, seq, role, content_json)
		 VALUES ('user-1', 'sess-1', 1, 'user', '"hello"')`,
	);
});

afterEach(() => {
	db.close();
});

describe("DurableRunTimelineBuilder", () => {
	test("merges tool start, safe input, repeated running, and result", () => {
		const builder = startBuilder();
		builder.apply(
			{
				event: "message.tool_call_start",
				message_id: "assistant-1",
				tool_call_id: "tool-1",
				tool_name: "Bash",
				parent_tool_use_id: null,
				is_mcp: false,
			},
			2,
		);
		builder.apply({ event: "message.tool_call_input_delta", tool_call_id: "tool-1", json_delta: '{"command"' }, 3);
		builder.apply(
			{
				event: "message.tool_call_input_end",
				tool_call_id: "tool-1",
				input: { command: "echo hello", env: { SECRET_TOKEN: "raw-secret" } },
			},
			4,
		);
		builder.apply(
			{ event: "message.tool_call_running", tool_call_id: "tool-1", tool_name: "Bash", elapsed_seconds: 2 },
			5,
		);
		builder.apply(
			{ event: "message.tool_call_running", tool_call_id: "tool-1", tool_name: "Bash", elapsed_seconds: 7 },
			6,
		);
		builder.apply(
			{
				event: "message.tool_call_result",
				tool_call_id: "tool-1",
				tool_name: "Bash",
				status: "success",
				duration_ms: 8000,
				output: "hello",
			},
			7,
		);

		const summary = builder.toUpsertParams().summary;
		expect(summary.tools).toHaveLength(1);
		expect(summary.tools[0]).toMatchObject({
			id: "tool-1",
			name: "Bash",
			state: "result",
			elapsedSeconds: 7,
			durationMs: 8000,
			safeInputSummary: "command: echo",
			safeOutputSummary: "Tool produced output.",
		});
	});

	test("late streamed tool input does not downgrade a completed tool", () => {
		const builder = startBuilder();
		builder.apply(
			{
				event: "message.tool_call_running",
				tool_call_id: "tool-late",
				tool_name: "Bash",
				elapsed_seconds: 0,
				phase: "started",
				input_preview: '{\n  "command": "sleep 45"\n}',
			},
			2,
		);
		builder.apply(
			{
				event: "message.tool_call_result",
				tool_call_id: "tool-late",
				tool_name: "Bash",
				status: "success",
				duration_ms: 45029,
				output: "exit_code: 0\nstdout:\nPHANTOM_RUN_CONSOLE_SENTINEL\nstderr:",
			},
			3,
		);
		builder.apply(
			{
				event: "message.tool_call_start",
				message_id: "assistant-1",
				tool_call_id: "tool-late",
				tool_name: "Bash",
				parent_tool_use_id: null,
				is_mcp: false,
			},
			4,
		);
		builder.apply(
			{
				event: "message.tool_call_input_end",
				tool_call_id: "tool-late",
				input: { command: "sleep 45", description: "Run requested sentinel command" },
			},
			5,
		);

		const summary = builder.toUpsertParams().summary;
		expect(summary.tools[0]).toMatchObject({
			id: "tool-late",
			name: "Bash",
			state: "result",
			durationMs: 45029,
			safeInputSummary: "command: sleep; description: Run requested sentinel command",
		});
		expect(summary.tools[0]?.safeOutputSummary).toBe("Tool produced output.");
	});

	test("records blocked, aborted, compaction, MCP, rate limit, and subagents", () => {
		const builder = startBuilder();
		const frames: Array<{ frame: ChatWireFrame; seq: number }> = [
			{
				seq: 2,
				frame: {
					event: "message.tool_call_blocked",
					tool_call_id: "tool-1",
					tool_name: "Write",
					hook_name: "policy",
					reason: "Needs approval",
				},
			},
			{ seq: 3, frame: { event: "message.tool_call_aborted", tool_call_id: "tool-2", tool_name: "Bash" } },
			{ seq: 4, frame: { event: "session.compact_boundary", trigger: "auto", pre_tokens: 12345 } },
			{
				seq: 5,
				frame: { event: "session.mcp_status", servers: [{ name: "filesystem", status: "connected" }] },
			},
			{
				seq: 6,
				frame: {
					event: "session.rate_limit",
					status: "allowed_warning",
					rate_limit_type: "five_hour",
					utilization: 0.75,
				},
			},
			{
				seq: 7,
				frame: {
					event: "message.subagent_start",
					tool_call_id: "tool-3",
					task_id: "task-1",
					description: "Research files",
				},
			},
			{
				seq: 8,
				frame: {
					event: "message.subagent_progress",
					task_id: "task-1",
					summary: "Reading files",
					duration_ms: 1000,
					total_tokens: 200,
					tool_uses: 2,
				},
			},
			{
				seq: 9,
				frame: {
					event: "message.subagent_end",
					task_id: "task-1",
					status: "completed",
					output_file: "/tmp/out.md",
					summary: "Done",
				},
			},
		];
		for (const { frame, seq } of frames) builder.apply(frame, seq);

		const summary = builder.toUpsertParams().summary;
		expect(summary.tools.find((tool) => tool.id === "tool-1")?.state).toBe("blocked");
		expect(summary.tools.find((tool) => tool.id === "tool-2")?.state).toBe("aborted");
		expect(summary.compact).toEqual({ trigger: "auto", preTokens: 12345 });
		expect(summary.mcpServers).toEqual([{ name: "filesystem", status: "connected" }]);
		expect(summary.rateLimit?.utilization).toBe(0.75);
		expect(summary.subagents[0]).toMatchObject({ taskId: "task-1", status: "completed", summary: "Done" });
	});

	test("persists safe page artifacts without relying on full tool output", () => {
		const builder = startBuilder();
		builder.apply(
			{
				event: "message.tool_call_start",
				message_id: "assistant-1",
				tool_call_id: "tool-page",
				tool_name: "mcp__phantom-web-ui__phantom_create_page",
				parent_tool_use_id: null,
				is_mcp: true,
				mcp_server: "phantom-web-ui",
			},
			2,
		);
		builder.apply(
			{
				event: "message.tool_call_input_end",
				tool_call_id: "tool-page",
				input: { path: "reports/weekly.html", title: "Weekly Report" },
			},
			3,
		);
		builder.apply(
			{
				event: "message.tool_call_result",
				tool_call_id: "tool-page",
				tool_name: "mcp__phantom-web-ui__phantom_create_page",
				status: "success",
				duration_ms: 120,
				output: JSON.stringify({
					created: true,
					path: "reports/weekly.html",
					url: "http://127.0.0.1:3112/ui/reports/weekly.html",
					size: 8842,
				}),
			},
			4,
		);

		const summary = builder.toUpsertParams().summary;
		expect(summary.tools[0]?.safeOutputSummary).toBe("Tool produced output.");
		expect(summary.artifacts).toEqual([
			{
				id: "page:http://127.0.0.1:3112/ui/reports/weekly.html",
				type: "page",
				title: "Weekly Report",
				url: "http://127.0.0.1:3112/ui/reports/weekly.html",
				path: "reports/weekly.html",
				sizeBytes: 8842,
				sourceToolName: "phantom_create_page",
			},
		]);
	});

	test("keeps magic login links out of durable artifacts", () => {
		const builder = startBuilder();
		builder.apply(
			{
				event: "message.tool_call_start",
				message_id: "assistant-1",
				tool_call_id: "tool-login",
				tool_name: "mcp__phantom-web-ui__phantom_generate_login",
				parent_tool_use_id: null,
				is_mcp: true,
				mcp_server: "phantom-web-ui",
			},
			2,
		);
		builder.apply(
			{
				event: "message.tool_call_result",
				tool_call_id: "tool-login",
				tool_name: "mcp__phantom-web-ui__phantom_generate_login",
				status: "success",
				output: JSON.stringify({
					magicLink: "http://127.0.0.1:3112/ui/login?magic=secret",
					expiresIn: "10 minutes",
				}),
			},
			3,
		);

		expect(builder.toUpsertParams().summary.artifacts).toEqual([]);
	});

	test("records session done and session error terminal state", () => {
		const doneBuilder = startBuilder();
		doneBuilder.apply(
			{
				event: "session.done",
				session_id: "sess-1",
				message_id: "assistant-1",
				stop_reason: "end_turn",
				usage: { input_tokens: 10, output_tokens: 5 },
				cost_usd: 0.02,
				duration_ms: 1000,
				num_turns: 1,
			},
			2,
		);
		expect(doneBuilder.toUpsertParams().summary).toMatchObject({
			status: "completed",
			endSeq: 2,
			stopReason: "end_turn",
			inputTokens: 10,
			outputTokens: 5,
			costUsd: 0.02,
		});

		const errorBuilder = startBuilder();
		errorBuilder.apply(
			{
				event: "session.error",
				session_id: "sess-1",
				message_id: "assistant-1",
				subtype: "error_during_execution",
				recoverable: true,
				errors: ["Network failed"],
				cost_usd: 0,
				duration_ms: 50,
			},
			2,
		);
		const errorSummary = errorBuilder.toUpsertParams().summary;
		expect(errorSummary.status).toBe("error");
		expect(errorSummary.errors[0]).toMatchObject({ subtype: "error_during_execution", message: "Network failed" });
	});

	test("treats abort plus done as one aborted run", () => {
		const builder = startBuilder();
		builder.apply(
			{
				event: "session.aborted",
				session_id: "sess-1",
				message_id: "assistant-1",
				aborted_at: "2026-04-30T00:00:01.000Z",
				cost_usd: 0,
				duration_ms: 1000,
			},
			2,
		);
		builder.apply(
			{
				event: "session.done",
				session_id: "sess-1",
				message_id: "assistant-1",
				stop_reason: "aborted",
				usage: { input_tokens: 0, output_tokens: 0 },
				cost_usd: 0,
				duration_ms: 1000,
				num_turns: 0,
			},
			3,
		);
		const summary = builder.toUpsertParams().summary;
		expect(summary.status).toBe("aborted");
		expect(summary.endSeq).toBe(3);
		expect(summary.currentLabel).toBe("Run stopped.");
	});

	test("redacts secrets, truncates output, and drops raw thinking", () => {
		const builder = startBuilder();
		builder.apply(
			{
				event: "message.thinking_delta",
				thinking_block_id: "think-1",
				delta: "raw private chain of thought",
			},
			2,
		);
		builder.apply(
			{
				event: "message.tool_call_input_end",
				tool_call_id: "tool-1",
				input: {
					command: "API_KEY=sk-1234567890abcdef curl -H 'Authorization: Bearer raw-token' https://example.com",
					password: "raw-password",
				},
			},
			3,
		);
		builder.apply(
			{
				event: "message.tool_call_result",
				tool_call_id: "tool-1",
				status: "success",
				output: `Bearer raw-token ${"x".repeat(1000)}`,
			},
			4,
		);
		const summaryJson = JSON.stringify(builder.toUpsertParams().summary);
		expect(summaryJson).not.toContain("raw private chain of thought");
		expect(summaryJson).not.toContain("sk-1234567890abcdef");
		expect(summaryJson).not.toContain("raw-token");
		expect(summaryJson).not.toContain("raw-password");
		expect(summaryJson.length).toBeLessThan(2000);
		expect(builder.toUpsertParams().summary.tools[0]?.outputTruncated).toBe(true);
	});

	test("keeps durable tool summaries free of command output and credential-shaped values", () => {
		const builder = startBuilder();
		const secretText =
			"find AKIA1234567890123456 Cookie: session=abc; csrf=def -----BEGIN PRIVATE KEY----- raw-private-key";
		builder.apply(
			{
				event: "message.tool_call_input_end",
				tool_call_id: "tool-1",
				input: {
					command: "AWS_ACCESS_KEY_ID=AKIA1234567890123456 curl https://auth.example.com/callback?code=oauth-code-123",
					url: "https://auth.example.com/callback?code=oauth-code-123&access_token=access-token-123",
					query: secretText,
					pattern: secretText,
					description: secretText,
					task: secretText,
					title: secretText,
					private_key: "-----BEGIN PRIVATE KEY-----raw-private-key",
				},
			},
			2,
		);
		builder.apply(
			{
				event: "message.tool_call_result",
				tool_call_id: "tool-1",
				status: "success",
				output:
					"AWS_ACCESS_KEY_ID=AKIA1234567890123456 PRIVATE_KEY=raw-private-key https://auth.example.com/callback?code=oauth-code-123",
			},
			3,
		);

		const summary = builder.toUpsertParams().summary;
		const summaryJson = JSON.stringify(summary);
		expect(summary.tools[0]?.safeInputSummary).toBe(
			"command: curl; url: https://auth.example.com/callback; query: find [REDACTED_AWS_KEY] Cookie: [REDACTED]",
		);
		expect(summary.tools[0]?.safeOutputSummary).toBe("Tool produced output.");
		expect(summaryJson).not.toContain("AKIA1234567890123456");
		expect(summaryJson).not.toContain("csrf=def");
		expect(summaryJson).not.toContain("session=abc");
		expect(summaryJson).not.toContain("oauth-code-123");
		expect(summaryJson).not.toContain("access-token-123");
		expect(summaryJson).not.toContain("raw-private-key");
		expect(summaryJson).not.toContain("BEGIN PRIVATE KEY");
	});

	test("redacts credential shapes from every persisted safe-text summary field", () => {
		const builder = startBuilder();
		const secretText = "AKIA1234567890123456 Cookie: session=abc; csrf=def -----BEGIN PRIVATE KEY----- raw-private-key";
		builder.apply(
			{
				event: "message.tool_call_start",
				message_id: "assistant-1",
				tool_call_id: "tool-secret",
				tool_name: secretText,
				parent_tool_use_id: null,
				is_mcp: true,
				mcp_server: secretText,
			},
			2,
		);
		builder.apply(
			{
				event: "message.tool_call_blocked",
				tool_call_id: "tool-secret",
				tool_name: secretText,
				hook_name: "policy",
				reason: secretText,
			},
			3,
		);
		builder.apply(
			{
				event: "message.subagent_start",
				task_id: "task-secret",
				tool_call_id: "tool-secret",
				description: secretText,
			},
			4,
		);
		builder.apply(
			{
				event: "message.subagent_progress",
				task_id: "task-secret",
				summary: secretText,
				last_tool_name: secretText,
				duration_ms: 10,
				total_tokens: 20,
				tool_uses: 1,
			},
			5,
		);
		builder.apply(
			{
				event: "message.subagent_end",
				task_id: "task-secret",
				status: "completed",
				output_file: secretText,
				summary: secretText,
			},
			6,
		);
		builder.apply(
			{
				event: "session.error",
				session_id: "sess-1",
				message_id: "assistant-1",
				subtype: "error_during_execution",
				recoverable: false,
				errors: [secretText],
				cost_usd: 0,
				duration_ms: 1,
			},
			7,
		);

		const summaryJson = JSON.stringify(builder.toUpsertParams().summary);
		expect(summaryJson).not.toContain("AKIA1234567890123456");
		expect(summaryJson).not.toContain("csrf=def");
		expect(summaryJson).not.toContain("session=abc");
		expect(summaryJson).not.toContain("raw-private-key");
		expect(summaryJson).not.toContain("BEGIN PRIVATE KEY");
	});

	test("redacts header-style credentials from allowed input summaries", () => {
		const builder = startBuilder();
		const headerSecrets = "search X-CSRF-Token: csrf-token-123 X-XSRF-Token: xsrf-token-123 X-API-Key: api-key-123";
		builder.apply(
			{
				event: "message.tool_call_input_end",
				tool_call_id: "tool-1",
				input: {
					query: headerSecrets,
					pattern: headerSecrets,
					description: headerSecrets,
				},
			},
			2,
		);

		const summary = builder.toUpsertParams().summary;
		const summaryJson = JSON.stringify(summary);
		expect(summary.tools[0]?.safeInputSummary).toContain("X-CSRF-Token: [REDACTED]");
		expect(summary.tools[0]?.safeInputSummary).toContain("X-XSRF-Token: [REDACTED]");
		expect(summary.tools[0]?.safeInputSummary).toContain("X-API-Key: [REDACTED]");
		expect(summaryJson).not.toContain("csrf-token-123");
		expect(summaryJson).not.toContain("xsrf-token-123");
		expect(summaryJson).not.toContain("api-key-123");
	});
});

describe("ChatRunTimelineStore", () => {
	test("upserts and reads sanitized timeline details", () => {
		const store = new ChatRunTimelineStore(db);
		const builder = startBuilder();
		store.upsert(builder.toUpsertParams());

		const details = store.getDetailsBySession("sess-1");
		expect(details).toHaveLength(1);
		expect(details[0]?.user_message_id).toBe("user-1");
		expect(details[0]?.summary.status).toBe("working");
	});
});
