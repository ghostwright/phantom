import { describe, expect, it } from "vitest";
import { ACTIVE_RUN_MESSAGE_ID } from "../chat-activity";
import { beginRunActivity, createChatStore, dispatchFrame } from "../chat-store";

function send(store: ReturnType<typeof createChatStore>, event: string, data: Record<string, unknown>): void {
	dispatchFrame(store, event, JSON.stringify(data));
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
