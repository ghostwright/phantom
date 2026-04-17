import { describe, expect, test } from "bun:test";
import { createTranslationContext, translateSdkMessage } from "../sdk-to-wire.ts";

function makeCtx(sessionId = "sess-1", messageId = "msg-1") {
	return createTranslationContext(sessionId, messageId);
}

describe("sdk-to-wire translator", () => {
	test("system init -> session.created", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{ type: "system", subtype: "init", session_id: "sdk-123", mcp_servers: [] },
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("session.created");
	});

	test("system init with mcp_servers -> session.created + session.mcp_status", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{ type: "system", subtype: "init", session_id: "sdk-123", mcp_servers: [{ name: "test", status: "connected" }] },
			ctx,
		);
		expect(frames.length).toBe(2);
		expect(frames[0].event).toBe("session.created");
		expect(frames[1].event).toBe("session.mcp_status");
	});

	test("system status -> session.status", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{ type: "system", subtype: "status", status: "compacting", permissionMode: "bypassPermissions" },
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("session.status");
	});

	test("system compact_boundary -> session.compact_boundary", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 198000 } },
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("session.compact_boundary");
	});

	test("system task_started -> message.subagent_start", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tu1", description: "research" },
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("message.subagent_start");
	});

	test("system task_progress -> message.subagent_progress", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "system",
				subtype: "task_progress",
				task_id: "t1",
				summary: "reading files",
				usage: { total_tokens: 1000, tool_uses: 5, duration_ms: 3000 },
			},
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("message.subagent_progress");
	});

	test("system task_notification -> message.subagent_end", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "system",
				subtype: "task_notification",
				task_id: "t1",
				status: "completed",
				output_file: "/tmp/out.md",
				summary: "done",
				usage: { total_tokens: 2000, tool_uses: 10, duration_ms: 5000 },
			},
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("message.subagent_end");
	});

	test("system hook_response cancelled -> message.tool_call_blocked", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "system",
				subtype: "hook_response",
				outcome: "cancelled",
				hook_id: "h1",
				hook_name: "safety",
				output: "Blocked",
			},
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("message.tool_call_blocked");
	});

	test("system hook_response success -> no frames", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{ type: "system", subtype: "hook_response", outcome: "success", hook_id: "h1", hook_name: "safety" },
			ctx,
		);
		expect(frames.length).toBe(0);
	});

	test("assistant with text -> assistant_start + text_start + text_delta", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "Hello" }] },
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.length).toBe(3);
		expect(frames[0].event).toBe("message.assistant_start");
		expect(frames[1].event).toBe("message.text_start");
		expect(frames[2].event).toBe("message.text_delta");
	});

	test("assistant incremental text emits only delta", () => {
		const ctx = makeCtx();
		translateSdkMessage(
			{ type: "assistant", message: { content: [{ type: "text", text: "Hel" }] }, parent_tool_use_id: null },
			ctx,
		);
		const frames = translateSdkMessage(
			{ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] }, parent_tool_use_id: null },
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("message.text_delta");
		if (frames[0].event === "message.text_delta") {
			expect(frames[0].delta).toBe("lo");
		}
	});

	test("assistant with thinking -> thinking_start + thinking_delta", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "assistant",
				message: { content: [{ type: "thinking", thinking: "Let me think..." }] },
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.length).toBe(3);
		expect(frames[0].event).toBe("message.assistant_start");
		expect(frames[1].event).toBe("message.thinking_start");
		expect(frames[2].event).toBe("message.thinking_delta");
	});

	test("assistant with redacted_thinking -> thinking_start (no delta)", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "assistant",
				message: { content: [{ type: "redacted_thinking", thinking: "" }] },
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.length).toBe(2);
		expect(frames[1].event).toBe("message.thinking_start");
		if (frames[1].event === "message.thinking_start") {
			expect(frames[1].redacted).toBe(true);
		}
	});

	test("assistant with tool_use -> tool_call_start + tool_call_input_end", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "assistant",
				message: {
					content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file: "/tmp/test" } }],
				},
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.length).toBe(3);
		expect(frames[0].event).toBe("message.assistant_start");
		expect(frames[1].event).toBe("message.tool_call_start");
		expect(frames[2].event).toBe("message.tool_call_input_end");
	});

	test("assistant with empty content -> only assistant_start", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage({ type: "assistant", message: { content: [] }, parent_tool_use_id: null }, ctx);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("message.assistant_start");
	});

	test("stream_event content_block_start text -> text_start", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_start", content_block: { type: "text" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.some((f) => f.event === "message.text_start")).toBe(true);
	});

	test("stream_event content_block_delta text_delta -> text_delta", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.some((f) => f.event === "message.text_delta")).toBe(true);
	});

	test("stream_event content_block_delta thinking_delta -> thinking_delta", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.some((f) => f.event === "message.thinking_delta")).toBe(true);
	});

	test("stream_event content_block_delta input_json_delta -> tool_call_input_delta", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					delta: { type: "input_json_delta", partial_json: '{"f' },
					index: 0,
				},
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.some((f) => f.event === "message.tool_call_input_delta")).toBe(true);
	});

	test("stream_event message_stop -> assistant_end", () => {
		const ctx = makeCtx();
		ctx.assistantStartEmitted = true;
		const frames = translateSdkMessage(
			{ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: null },
			ctx,
		);
		expect(frames.some((f) => f.event === "message.assistant_end")).toBe(true);
	});

	test("result success -> session.done", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "result",
				subtype: "success",
				result: "done",
				stop_reason: "end_turn",
				total_cost_usd: 0.01,
				usage: { input_tokens: 100, output_tokens: 50 },
				duration_ms: 1000,
				num_turns: 1,
			},
			ctx,
		);
		expect(frames.some((f) => f.event === "session.done")).toBe(true);
	});

	test("result error -> session.error", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "result",
				subtype: "error_during_execution",
				errors: ["Network error"],
				total_cost_usd: 0.001,
				usage: {},
				duration_ms: 500,
			},
			ctx,
		);
		expect(frames.some((f) => f.event === "session.error")).toBe(true);
	});

	test("result with prompt_suggestion -> session.suggestion", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage({ type: "prompt_suggestion", suggestion: "Tell me more" }, ctx);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("session.suggestion");
	});

	test("tool_progress -> tool_call_running", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{ type: "tool_progress", tool_use_id: "tu_1", tool_name: "Bash", elapsed_time_seconds: 5 },
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("message.tool_call_running");
	});

	test("rate_limit_event -> session.rate_limit", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "rate_limit_event",
				rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.82 },
			},
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("session.rate_limit");
	});

	test("unknown message type -> empty", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage({ type: "unknown_future_type" }, ctx);
		expect(frames.length).toBe(0);
	});

	test("user message -> empty (synthetic tool result)", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{ type: "user", message: { role: "user", content: "test" }, parent_tool_use_id: null },
			ctx,
		);
		expect(frames.length).toBe(0);
	});

	test("session.created carries placeholder seq (assigned by writer)", () => {
		const ctx = makeCtx();
		const f1 = translateSdkMessage({ type: "system", subtype: "init", session_id: "s1", mcp_servers: [] }, ctx);
		if (f1[0].event === "session.created") {
			expect(f1[0].seq).toBe(0);
		}
	});

	test("content_block_stop emits only text_end for text block", () => {
		const ctx = makeCtx();
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_start", content_block: { type: "text" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		const frames = translateSdkMessage(
			{ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null },
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("message.text_end");
	});

	test("content_block_stop emits only thinking_end for thinking block", () => {
		const ctx = makeCtx();
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_start", content_block: { type: "thinking" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		const frames = translateSdkMessage(
			{ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null },
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("message.thinking_end");
	});

	test("content_block_stop emits tool_call_input_end for tool_use block", () => {
		const ctx = makeCtx();
		translateSdkMessage(
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					content_block: { type: "tool_use", id: "toolu_abc", name: "Read" },
					index: 2,
				},
				parent_tool_use_id: null,
			},
			ctx,
		);
		const frames = translateSdkMessage(
			{ type: "stream_event", event: { type: "content_block_stop", index: 2 }, parent_tool_use_id: null },
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("message.tool_call_input_end");
	});

	test("content_block_stop emits nothing for unknown block type", () => {
		const ctx = makeCtx();
		// Pre-emit assistant_start so the guard does not add an extra frame
		ctx.assistantStartEmitted = true;
		const frames = translateSdkMessage(
			{ type: "stream_event", event: { type: "content_block_stop", index: 99 }, parent_tool_use_id: null },
			ctx,
		);
		expect(frames.length).toBe(0);
	});

	// Regression tests for the v0.20.1 chat duplication fix. The SDK emits stream
	// deltas and then re-asserts the final content as a redundant assistant
	// message. Pre-fix, handleAssistant re-emitted text_start + text_delta,
	// producing two text blocks with the same block id in the client reducer.
	// Post-fix, streamed blocks reconcile via a single message.text_reconcile
	// frame.

	test("stream_event + assistant combined: final assistant emits a single text_reconcile frame, not text_start/text_delta", () => {
		const ctx = makeCtx();
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_start", content_block: { type: "text" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "text_delta", text: " world" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		translateSdkMessage(
			{ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null },
			ctx,
		);
		translateSdkMessage({ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: null }, ctx);
		const frames = translateSdkMessage(
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "Hello world" }] },
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("message.text_reconcile");
		if (frames[0].event === "message.text_reconcile") {
			expect(frames[0].text_block_id).toBe("tb_0_0");
			expect(frames[0].full_text).toBe("Hello world");
		}
		expect(frames.some((f) => f.event === "message.text_start")).toBe(false);
		expect(frames.some((f) => f.event === "message.text_delta")).toBe(false);
	});

	test("stream_event + assistant combined: divergent final text is reconciled to canonical", () => {
		const ctx = makeCtx();
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_start", content_block: { type: "text" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello world" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		const frames = translateSdkMessage(
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "Hello, world!" }] },
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("message.text_reconcile");
		if (frames[0].event === "message.text_reconcile") {
			expect(frames[0].full_text).toBe("Hello, world!");
		}
	});

	test("assistant-only path (no prior stream_event): original diff emit is preserved", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "Hello" }] },
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.length).toBe(3);
		expect(frames[0].event).toBe("message.assistant_start");
		expect(frames[1].event).toBe("message.text_start");
		expect(frames[2].event).toBe("message.text_delta");
		expect(frames.some((f) => f.event === "message.text_reconcile")).toBe(false);
	});

	test("stream_event + assistant combined: thinking final emits start+delta(fullText) which the Map-indirect client reducer replaces idempotently", () => {
		const ctx = makeCtx();
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_start", content_block: { type: "thinking" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Let me think" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		translateSdkMessage(
			{ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null },
			ctx,
		);
		const frames = translateSdkMessage(
			{
				type: "assistant",
				message: { content: [{ type: "thinking", thinking: "Let me think" }] },
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.length).toBe(2);
		expect(frames[0].event).toBe("message.thinking_start");
		expect(frames[1].event).toBe("message.thinking_delta");
		if (frames[1].event === "message.thinking_delta") {
			expect(frames[1].delta).toBe("Let me think");
		}
	});

	test("stream_event + assistant combined: thinking final snaps to canonical when deltas diverge (stream='abc', final='abcd')", () => {
		const ctx = makeCtx();
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_start", content_block: { type: "thinking" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "abc" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		translateSdkMessage(
			{ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null },
			ctx,
		);
		const frames = translateSdkMessage(
			{
				type: "assistant",
				message: { content: [{ type: "thinking", thinking: "abcd" }] },
				parent_tool_use_id: null,
			},
			ctx,
		);
		// thinking_start replaces the client's Map entry, thinking_delta fills
		// with the canonical "abcd". The "d" missing from the stream is restored.
		expect(frames.length).toBe(2);
		expect(frames[0].event).toBe("message.thinking_start");
		expect(frames[1].event).toBe("message.thinking_delta");
		if (frames[1].event === "message.thinking_delta") {
			expect(frames[1].delta).toBe("abcd");
		}
	});

	test("stream_event + assistant combined: tool_use block still guarded by startedToolIds", () => {
		const ctx = makeCtx();
		translateSdkMessage(
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					content_block: { type: "tool_use", id: "toolu_abc", name: "Read" },
					index: 0,
				},
				parent_tool_use_id: null,
			},
			ctx,
		);
		const frames = translateSdkMessage(
			{
				type: "assistant",
				message: {
					content: [{ type: "tool_use", id: "toolu_abc", name: "Read", input: { file: "/tmp/x" } }],
				},
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.some((f) => f.event === "message.tool_call_start")).toBe(false);
		expect(frames.some((f) => f.event === "message.tool_call_input_end")).toBe(false);
	});

	test("stream_event + assistant combined: interleaved [text, tool_use, text] reconciles each text block independently", () => {
		const ctx = makeCtx();
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_start", content_block: { type: "text" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "text_delta", text: "Part one" }, index: 0 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		translateSdkMessage(
			{ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null },
			ctx,
		);
		translateSdkMessage(
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					content_block: { type: "tool_use", id: "toolu_x", name: "Read" },
					index: 1,
				},
				parent_tool_use_id: null,
			},
			ctx,
		);
		translateSdkMessage(
			{ type: "stream_event", event: { type: "content_block_stop", index: 1 }, parent_tool_use_id: null },
			ctx,
		);
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_start", content_block: { type: "text" }, index: 2 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "text_delta", text: "Part two" }, index: 2 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		translateSdkMessage(
			{ type: "stream_event", event: { type: "content_block_stop", index: 2 }, parent_tool_use_id: null },
			ctx,
		);
		const frames = translateSdkMessage(
			{
				type: "assistant",
				message: {
					content: [
						{ type: "text", text: "Part one" },
						{ type: "tool_use", id: "toolu_x", name: "Read", input: { f: 1 } },
						{ type: "text", text: "Part two" },
					],
				},
				parent_tool_use_id: null,
			},
			ctx,
		);
		const reconciles = frames.filter((f) => f.event === "message.text_reconcile");
		expect(reconciles.length).toBe(2);
		if (reconciles[0].event === "message.text_reconcile") {
			expect(reconciles[0].text_block_id).toBe("tb_0_0");
			expect(reconciles[0].full_text).toBe("Part one");
		}
		if (reconciles[1].event === "message.text_reconcile") {
			expect(reconciles[1].text_block_id).toBe("tb_0_2");
			expect(reconciles[1].full_text).toBe("Part two");
		}
		expect(frames.some((f) => f.event === "message.text_start")).toBe(false);
		expect(frames.some((f) => f.event === "message.text_delta")).toBe(false);
		expect(frames.some((f) => f.event === "message.tool_call_start")).toBe(false);
	});

	test("assistant-only path: empty text block emits start but no delta", () => {
		const ctx = makeCtx();
		const frames = translateSdkMessage(
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "" }] },
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.length).toBe(2);
		expect(frames[0].event).toBe("message.assistant_start");
		expect(frames[1].event).toBe("message.text_start");
		expect(frames.some((f) => f.event === "message.text_delta")).toBe(false);
		expect(frames.some((f) => f.event === "message.text_reconcile")).toBe(false);
	});

	test("input_json_delta uses real tool_call_id from content_block_start", () => {
		const ctx = makeCtx();
		translateSdkMessage(
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					content_block: { type: "tool_use", id: "toolu_real_123", name: "Bash" },
					index: 1,
				},
				parent_tool_use_id: null,
			},
			ctx,
		);
		const frames = translateSdkMessage(
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"cmd' }, index: 1 },
				parent_tool_use_id: null,
			},
			ctx,
		);
		expect(frames.length).toBe(1);
		expect(frames[0].event).toBe("message.tool_call_input_delta");
		if (frames[0].event === "message.tool_call_input_delta") {
			expect(frames[0].tool_call_id).toBe("toolu_real_123");
		}
	});
});
