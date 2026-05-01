import { describe, expect, it } from "vitest";
import { shouldBlockSendAfterUpload } from "../../hooks/use-attachments";
import { ACTIVE_RUN_MESSAGE_ID } from "../chat-activity";
import { getAssistantTextBlocks } from "../chat-message-content";
import { beginRunActivity, createChatStore, dispatchFrame } from "../chat-store";

function send(store: ReturnType<typeof createChatStore>, event: string, data: Record<string, unknown>): void {
	dispatchFrame(store, event, JSON.stringify(data));
}

function replay(store: ReturnType<typeof createChatStore>, event: string, data: Record<string, unknown>): void {
	dispatchFrame(store, event, JSON.stringify(data), { source: "replay" });
}

describe("chat-store reducer: text block lifecycle", () => {
	it("accumulates text_delta into a single content block for one text_start", () => {
		const store = createChatStore();
		send(store, "message.assistant_start", { message_id: "a1" });
		send(store, "message.text_start", {
			message_id: "a1",
			text_block_id: "tb_0_0",
			index: 0,
		});
		send(store, "message.text_delta", {
			text_block_id: "tb_0_0",
			delta: "Hello",
		});
		send(store, "message.text_delta", {
			text_block_id: "tb_0_0",
			delta: " world",
		});
		send(store, "message.text_end", { text_block_id: "tb_0_0" });
		send(store, "message.assistant_end", {
			message_id: "a1",
			interrupted: false,
		});

		const state = store.getState();
		const last = state.messages[state.messages.length - 1];
		expect(last?.role).toBe("assistant");
		expect(last?.content.length).toBe(1);
		expect(last?.content[0]?.type).toBe("text");
		expect(last?.content[0]?.text).toBe("Hello world");
		expect(last?.content[0]?.blockId).toBe("tb_0_0");
	});

	it("text_reconcile replaces accumulated delta text instead of appending", () => {
		const store = createChatStore();
		send(store, "message.assistant_start", { message_id: "a1" });
		send(store, "message.text_start", {
			message_id: "a1",
			text_block_id: "tb_0_0",
			index: 0,
		});
		send(store, "message.text_delta", {
			text_block_id: "tb_0_0",
			delta: "Hello world",
		});
		send(store, "message.text_end", { text_block_id: "tb_0_0" });
		send(store, "message.assistant_end", {
			message_id: "a1",
			interrupted: false,
		});
		send(store, "message.text_reconcile", {
			text_block_id: "tb_0_0",
			full_text: "Hello world",
		});

		const state = store.getState();
		const last = state.messages[state.messages.length - 1];
		expect(last?.content.length).toBe(1);
		expect(last?.content[0]?.text).toBe("Hello world");
	});

	it("text_reconcile with divergent canonical text snaps the block to the final value", () => {
		const store = createChatStore();
		send(store, "message.assistant_start", { message_id: "a1" });
		send(store, "message.text_start", {
			message_id: "a1",
			text_block_id: "tb_0_0",
			index: 0,
		});
		send(store, "message.text_delta", {
			text_block_id: "tb_0_0",
			delta: "Hello wrold",
		});
		send(store, "message.text_end", { text_block_id: "tb_0_0" });
		send(store, "message.text_reconcile", {
			text_block_id: "tb_0_0",
			full_text: "Hello world",
		});

		const state = store.getState();
		const last = state.messages[state.messages.length - 1];
		expect(last?.content.length).toBe(1);
		expect(last?.content[0]?.text).toBe("Hello world");
	});

	it("text_reconcile for a block that was never started is a no-op", () => {
		const store = createChatStore();
		send(store, "message.assistant_start", { message_id: "a1" });
		send(store, "message.text_reconcile", {
			text_block_id: "tb_0_0",
			full_text: "Hello world",
		});

		const state = store.getState();
		const last = state.messages[state.messages.length - 1];
		expect(last?.role).toBe("assistant");
		expect(last?.content.length).toBe(0);
	});

	it("assistant_end closes a late open thinking block", () => {
		const store = createChatStore();
		send(store, "message.assistant_start", { message_id: "a1" });
		send(store, "message.thinking_start", {
			message_id: "a1",
			thinking_block_id: "tk_0_0",
			index: 0,
			redacted: false,
		});

		expect(store.getState().thinkingBlocks.get("tk_0_0")?.isStreaming).toBe(true);

		send(store, "message.assistant_end", {
			message_id: "a1",
			interrupted: false,
		});

		expect(store.getState().thinkingBlocks.get("tk_0_0")?.isStreaming).toBe(false);
	});

	it("preserves multiple assistant text blocks for rendering", () => {
		const store = createChatStore();
		send(store, "message.assistant_start", { message_id: "a1" });
		send(store, "message.text_start", {
			message_id: "a1",
			text_block_id: "tb_0_0",
			index: 0,
		});
		send(store, "message.text_delta", {
			text_block_id: "tb_0_0",
			delta: "Before the tool.",
		});
		send(store, "message.text_end", { text_block_id: "tb_0_0" });
		send(store, "message.text_start", {
			message_id: "a1",
			text_block_id: "tb_0_2",
			index: 2,
		});
		send(store, "message.text_delta", {
			text_block_id: "tb_0_2",
			delta: "After the tool.",
		});
		send(store, "message.text_end", { text_block_id: "tb_0_2" });

		const assistant = store.getState().messages[0];
		expect(assistant?.content.filter((block) => block.type === "text")).toHaveLength(2);
		if (assistant) {
			expect(getAssistantTextBlocks(assistant)).toEqual(["Before the tool.", "After the tool."]);
		}
	});

	it("session.error marks a previously ended assistant row as error", () => {
		const store = createChatStore();
		send(store, "message.assistant_start", { message_id: "a1" });
		send(store, "message.text_start", {
			message_id: "a1",
			text_block_id: "tb_0_0",
			index: 0,
		});
		send(store, "message.text_delta", {
			text_block_id: "tb_0_0",
			delta: "Partial answer",
		});
		send(store, "message.assistant_end", {
			message_id: "a1",
			interrupted: false,
		});
		expect(store.getState().messages[0]?.status).toBe("committed");

		send(store, "session.error", {
			session_id: "s1",
			message_id: "a1",
			subtype: "error_during_execution",
			recoverable: false,
			errors: ["Provider failed"],
			cost_usd: 0,
			duration_ms: 10,
		});

		expect(store.getState().messages[0]?.status).toBe("error");
	});
});

describe("chat-store reducer: user attachments", () => {
	it("preserves attachment metadata from user.message frames", () => {
		const store = createChatStore();
		send(store, "user.message", {
			message_id: "u1",
			text: "Review this.",
			attachments: [
				{
					id: "att-1",
					filename: "brief.pdf",
					mime_type: "application/pdf",
					size_bytes: 1234,
					preview_url: "/chat/attachments/att-1/preview",
				},
			],
			sent_at: "2026-04-30T00:00:00.000Z",
			source_tab_id: "tab-1",
		});

		const user = store.getState().messages[0];
		expect(user?.attachments).toEqual([
			{
				id: "att-1",
				filename: "brief.pdf",
				mimeType: "application/pdf",
				sizeBytes: 1234,
				previewUrl: "/chat/attachments/att-1/preview",
			},
		]);
	});

	it("replayed user.message attachments are idempotent", () => {
		const store = createChatStore();
		const frame = {
			message_id: "u1",
			text: "Review this.",
			attachments: [
				{
					id: "att-1",
					filename: "brief.pdf",
					mime_type: "application/pdf",
					size_bytes: 1234,
					preview_url: "/chat/attachments/att-1/preview",
				},
			],
			sent_at: "2026-04-30T00:00:00.000Z",
			source_tab_id: "tab-1",
		};
		replay(store, "user.message", frame);
		replay(store, "user.message", frame);

		const user = store.getState().messages[0];
		expect(user?.attachments).toHaveLength(1);
		expect(user?.attachments?.[0]?.id).toBe("att-1");
	});
});

describe("attachment upload send gate", () => {
	it("distinguishes no files from failed intended uploads", () => {
		expect(shouldBlockSendAfterUpload({ intendedCount: 0, acceptedIds: [], failedCount: 0 })).toBe(false);
		expect(shouldBlockSendAfterUpload({ intendedCount: 1, acceptedIds: [], failedCount: 1 })).toBe(true);
		expect(shouldBlockSendAfterUpload({ intendedCount: 2, acceptedIds: ["att-1"], failedCount: 1 })).toBe(true);
		expect(shouldBlockSendAfterUpload({ intendedCount: 1, acceptedIds: ["att-1"], failedCount: 0 })).toBe(false);
	});
});

describe("chat-store reducer: run activity", () => {
	it("beginRunActivity makes visible run activity available before assistant start", () => {
		const store = createChatStore();
		beginRunActivity(store);

		const state = store.getState();
		expect(state.messages.length).toBe(0);
		expect(state.isStreaming).toBe(true);
		expect(state.runActivity?.isActive).toBe(true);
		expect(state.runActivity?.currentLabel).toBe("Starting...");
	});

	it("session.status compacting updates run activity", () => {
		const store = createChatStore();
		beginRunActivity(store);
		send(store, "session.status", {
			status: "compacting",
			permission_mode: "bypassPermissions",
		});

		const state = store.getState();
		expect(state.runActivity?.status).toBe("compacting");
		expect(state.runActivity?.currentLabel).toBe("Compacting context...");
	});

	it("session.compact_boundary records safe compaction activity", () => {
		const store = createChatStore();
		beginRunActivity(store);
		send(store, "session.compact_boundary", {
			trigger: "auto",
			pre_tokens: 670000,
		});

		const state = store.getState();
		expect(state.runActivity?.compact).toEqual({
			trigger: "auto",
			preTokens: 670000,
		});
		expect(state.runActivity?.currentLabel).toBe("Compacted context and kept working.");
	});

	it("orphan tool_call_running creates a safe placeholder", () => {
		const store = createChatStore();
		beginRunActivity(store);
		send(store, "message.tool_call_running", {
			tool_call_id: "tu_orphan",
			elapsed_seconds: 3,
		});

		const state = store.getState();
		const tool = state.activeToolCalls.get("tu_orphan");
		expect(tool?.messageId).toBe(ACTIVE_RUN_MESSAGE_ID);
		expect(tool?.toolName).toBe("Tool");
		expect(tool?.state).toBe("running");
		expect(tool?.elapsedSeconds).toBe(3);
	});

	it("tool_call_running updates safe previews without completing the tool", () => {
		const store = createChatStore();
		beginRunActivity(store);
		send(store, "message.tool_call_running", {
			tool_call_id: "tu_preview",
			tool_name: "Bash",
			elapsed_seconds: 2,
			phase: "partial_output",
			input_preview: "command: sleep 1",
			output_preview: "working",
			output_truncated: true,
			full_ref: "/tmp/tool-output.txt",
		});

		const tool = store.getState().activeToolCalls.get("tu_preview");
		expect(tool?.state).toBe("running");
		expect(tool?.phase).toBe("partial_output");
		expect(tool?.inputJson).toBe("command: sleep 1");
		expect(tool?.output).toBe("working");
		expect(tool?.outputTruncated).toBe(true);
		expect(tool?.fullRef).toBe("/tmp/tool-output.txt");
	});

	it("orphan tool progress during a new turn does not attach to the prior assistant", () => {
		const store = createChatStore();
		send(store, "message.assistant_start", { message_id: "a1" });
		send(store, "message.assistant_end", {
			message_id: "a1",
			interrupted: false,
		});

		beginRunActivity(store);
		send(store, "message.tool_call_running", {
			tool_call_id: "tu_next",
			elapsed_seconds: 4,
		});

		expect(store.getState().activeToolCalls.get("tu_next")?.messageId).toBe(ACTIVE_RUN_MESSAGE_ID);

		send(store, "message.assistant_start", { message_id: "a2" });
		expect(store.getState().activeToolCalls.get("tu_next")?.messageId).toBe("a2");
	});

	it("starting a new run clears stale active-run placeholder tools", () => {
		const store = createChatStore();
		beginRunActivity(store);
		send(store, "message.tool_call_running", {
			tool_call_id: "tu_stale",
			elapsed_seconds: 5,
		});
		send(store, "session.error", {
			session_id: "s1",
			message_id: "a_missing",
			subtype: "error_during_execution",
			recoverable: false,
			errors: ["failed"],
			duration_ms: 10,
		});

		beginRunActivity(store);

		expect(store.getState().activeToolCalls.has("tu_stale")).toBe(false);
		expect(store.getState().runActivity?.currentLabel).toBe("Starting...");
	});

	it("terminal session.done does not clear completed tool state", () => {
		const store = createChatStore();
		send(store, "message.assistant_start", { message_id: "a1" });
		send(store, "message.tool_call_start", {
			message_id: "a1",
			tool_call_id: "tu_1",
			tool_name: "Read",
			is_mcp: false,
		});
		send(store, "message.tool_call_result", {
			tool_call_id: "tu_1",
			status: "success",
			output: "done",
		});
		send(store, "session.done", {
			session_id: "s1",
			message_id: "a1",
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
			cost_usd: 0,
			duration_ms: 10,
			num_turns: 1,
		});

		const state = store.getState();
		expect(state.isStreaming).toBe(false);
		expect(state.runActivity?.status).toBe("completed");
		expect(state.activeToolCalls.get("tu_1")?.state).toBe("result");
		expect(state.activeToolCalls.get("tu_1")?.output).toBe("done");
	});

	it("late streamed tool input does not erase completed progress state", () => {
		const store = createChatStore();
		beginRunActivity(store);
		send(store, "message.tool_call_running", {
			tool_call_id: "tu_late",
			tool_name: "Bash",
			phase: "started",
			input_preview: '{\n  "command": "sleep 7"\n}',
			elapsed_seconds: 0,
		});
		send(store, "message.tool_call_result", {
			tool_call_id: "tu_late",
			tool_name: "Bash",
			status: "success",
			duration_ms: 7034,
			output: "exit_code: 0\nstdout:\nPHANTOM_RUN_CONSOLE_SENTINEL\nstderr:",
		});
		send(store, "message.assistant_start", { message_id: "a1" });
		send(store, "message.tool_call_start", {
			message_id: "a1",
			tool_call_id: "tu_late",
			tool_name: "Bash",
		});
		send(store, "message.tool_call_input_delta", {
			tool_call_id: "tu_late",
			json_delta: '{"command":"sleep 7"}',
		});
		send(store, "message.tool_call_input_end", {
			tool_call_id: "tu_late",
			input: { command: "sleep 7" },
		});

		const tool = store.getState().activeToolCalls.get("tu_late");
		expect(tool).toMatchObject({
			messageId: "a1",
			toolName: "Bash",
			state: "result",
			phase: "completed",
			durationMs: 7034,
		});
		expect(tool?.inputJson).toContain("sleep 7");
		expect(tool?.inputJson).not.toContain('}{"command"');
		expect(tool?.output).toContain("PHANTOM_RUN_CONSOLE_SENTINEL");
	});

	it("subagent frames produce activity state", () => {
		const store = createChatStore();
		beginRunActivity(store);
		send(store, "message.subagent_start", {
			tool_call_id: "tu_agent",
			task_id: "task_1",
			description: "Research the repo",
		});
		send(store, "message.subagent_progress", {
			task_id: "task_1",
			summary: "Reading files",
			last_tool_name: "Read",
			duration_ms: 1200,
			total_tokens: 500,
			tool_uses: 2,
		});
		send(store, "message.subagent_end", {
			task_id: "task_1",
			status: "completed",
			output_file: "/tmp/out.md",
			summary: "Found the issue",
			duration_ms: 2500,
			total_tokens: 900,
			tool_uses: 4,
		});

		const subagent = store.getState().runActivity?.subagents.get("task_1");
		expect(subagent?.status).toBe("completed");
		expect(subagent?.summary).toBe("Found the issue");
		expect(subagent?.toolUses).toBe(4);
	});
});

describe("chat-store reducer: replay idempotency", () => {
	it("upserts replayed user and assistant messages by message id", () => {
		const store = createChatStore();
		store.update((state) => ({
			...state,
			messages: [
				{
					id: "u1",
					role: "user",
					content: [{ type: "text", text: "Hello" }],
					createdAt: "2026-04-30T00:00:00.000Z",
					status: "committed",
				},
				{
					id: "a1",
					role: "assistant",
					content: [{ type: "text", text: "Hello world" }],
					createdAt: "2026-04-30T00:00:01.000Z",
					status: "committed",
				},
			],
		}));

		replay(store, "user.message", {
			message_id: "u1",
			text: "Hello",
			attachments: [],
			sent_at: "2026-04-30T00:00:00.000Z",
			source_tab_id: "tab-1",
		});
		replay(store, "message.assistant_start", { message_id: "a1", parent_tool_use_id: null });

		expect(store.getState().messages.map((message) => message.id)).toEqual(["u1", "a1"]);
	});

	it("does not duplicate replayed text over a committed final assistant", () => {
		const store = createChatStore();
		store.update((state) => ({
			...state,
			messages: [
				{
					id: "a1",
					role: "assistant",
					content: [{ type: "text", text: "Hello world" }],
					createdAt: "2026-04-30T00:00:01.000Z",
					status: "committed",
				},
			],
		}));

		replay(store, "message.assistant_start", { message_id: "a1", parent_tool_use_id: null });
		replay(store, "message.text_start", { message_id: "a1", text_block_id: "tb_0_0", index: 0 });
		replay(store, "message.text_delta", { text_block_id: "tb_0_0", delta: "Hello world" });

		const assistant = store.getState().messages[0];
		expect(assistant?.content).toEqual([{ type: "text", text: "Hello world" }]);
		expect(store.getState().textBlocks.get("tb_0_0")?.text).toBe("Hello world");
	});

	it("reconstructs partial assistant text during replay when no committed assistant exists", () => {
		const store = createChatStore();
		replay(store, "message.assistant_start", { message_id: "a1", parent_tool_use_id: null });
		replay(store, "message.text_start", { message_id: "a1", text_block_id: "tb_0_0", index: 0 });
		replay(store, "message.text_delta", { text_block_id: "tb_0_0", delta: "Partial" });

		const assistant = store.getState().messages[0];
		expect(assistant?.role).toBe("assistant");
		expect(assistant?.content[0]?.text).toBe("Partial");
	});

	it("merges orphan running, later start, and later result into one tool call", () => {
		const store = createChatStore();
		beginRunActivity(store);
		replay(store, "message.tool_call_running", { tool_call_id: "tool-1", elapsed_seconds: 2 });
		replay(store, "message.tool_call_start", {
			message_id: "a1",
			tool_call_id: "tool-1",
			tool_name: "Read",
			is_mcp: false,
		});
		replay(store, "message.tool_call_result", {
			tool_call_id: "tool-1",
			tool_name: "Read",
			status: "success",
			output: "done",
		});

		expect(store.getState().activeToolCalls.size).toBe(1);
		expect(store.getState().activeToolCalls.get("tool-1")).toMatchObject({
			toolName: "Read",
			state: "result",
			output: "done",
		});
	});
});

describe("chat-store reducer: connection state", () => {
	it("tracks replaying and attached separately from streaming state", () => {
		const store = createChatStore();
		beginRunActivity(store);
		send(store, "session.resumed", {
			session_id: "s1",
			resumed_from_seq: 3,
			writer_active: true,
		});
		expect(store.getState().streamConnectionState).toBe("replaying");
		expect(store.getState().isStreaming).toBe(true);
		expect(store.getState().lastSeq).toBe(0);

		send(store, "session.caught_up", { session_id: "s1", up_to_seq: 5 });
		expect(store.getState().streamConnectionState).toBe("attached");
	});

	it("marks completed replay as detached, not attached live work", () => {
		const store = createChatStore();
		send(store, "session.resumed", {
			session_id: "s1",
			resumed_from_seq: 0,
			writer_active: false,
		});
		replay(store, "session.done", {
			session_id: "s1",
			message_id: "a1",
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
			cost_usd: 0,
			duration_ms: 10,
			num_turns: 1,
		});
		send(store, "session.caught_up", { session_id: "s1", up_to_seq: 2 });

		expect(store.getState().streamConnectionState).toBe("detached");
		expect(store.getState().runActivity?.status).toBe("completed");
	});

	it("marks server restart recovery as interrupted", () => {
		const store = createChatStore();
		beginRunActivity(store);
		send(store, "session.error", {
			session_id: "s1",
			message_id: null,
			subtype: "server_restart",
			recoverable: true,
			errors: ["Stream ended before the session completed."],
			cost_usd: 0,
			duration_ms: 0,
		});

		expect(store.getState().streamConnectionState).toBe("interrupted");
		expect(store.getState().runActivity?.currentLabel).toBe("Connection interrupted.");
	});
});
