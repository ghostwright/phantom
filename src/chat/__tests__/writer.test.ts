import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { ChatAttachmentStore } from "../attachment-store.ts";
import { ChatEventLog } from "../event-log.ts";
import { buildUserTranscriptContent } from "../message-builder.ts";
import { ChatMessageStore } from "../message-store.ts";
import { ChatRunTimelineStore } from "../run-timeline.ts";
import { ChatSessionStore } from "../session-store.ts";
import { StreamBus } from "../stream-bus.ts";
import type { ChatWireFrame } from "../types.ts";
import { ChatSessionWriter, getActiveWriter } from "../writer.ts";

let db: Database;
let sessionStore: ChatSessionStore;
let messageStore: ChatMessageStore;
let attachmentStore: ChatAttachmentStore;
let eventLog: ChatEventLog;
let timelineStore: ChatRunTimelineStore;
let streamBus: StreamBus;

beforeEach(() => {
	db = new Database(":memory:");
	for (const sql of MIGRATIONS) {
		db.run(sql);
	}
	sessionStore = new ChatSessionStore(db);
	messageStore = new ChatMessageStore(db);
	attachmentStore = new ChatAttachmentStore(db);
	eventLog = new ChatEventLog(db);
	timelineStore = new ChatRunTimelineStore(db);
	streamBus = new StreamBus();
});

afterEach(() => {
	db.close();
});

function mockRuntime(overrides?: {
	runForChat?: (
		key: string,
		msg: unknown,
		opts: { signal: AbortSignal; onSdkEvent: (msg: unknown) => void; sessionContext?: string },
	) => Promise<{
		text: string;
		sessionId: string;
		cost: { totalUsd: number; inputTokens: number; outputTokens: number; modelUsage: Record<string, unknown> };
		durationMs: number;
	}>;
}) {
	return {
		runForChat:
			overrides?.runForChat ??
			(async (_key: string, _msg: unknown, opts: { onSdkEvent: (msg: unknown) => void }) => {
				opts.onSdkEvent({ type: "system", subtype: "init", session_id: "sdk-1", mcp_servers: [] });
				opts.onSdkEvent({
					type: "assistant",
					message: { content: [{ type: "text", text: "Hello!" }] },
					parent_tool_use_id: null,
				});
				opts.onSdkEvent({
					type: "result",
					subtype: "success",
					result: "Hello!",
					stop_reason: "end_turn",
					total_cost_usd: 0.01,
					usage: { input_tokens: 100, output_tokens: 50 },
					modelUsage: {},
					duration_ms: 1000,
					num_turns: 1,
				});
				return {
					text: "Hello!",
					sessionId: "sdk-1",
					cost: { totalUsd: 0.01, inputTokens: 100, outputTokens: 50, modelUsage: {} },
					durationMs: 1000,
				};
			}),
		judgeQuery: async () => ({ data: { title: "Test Chat" } }),
	} as unknown as ConstructorParameters<typeof ChatSessionWriter>[0]["runtime"];
}

describe("ChatSessionWriter", () => {
	test("normal completion emits user.message and session events", async () => {
		const session = sessionStore.create();
		const frames: ChatWireFrame[] = [];
		streamBus.subscribe(session.id, (f) => frames.push(f));

		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime(),
			eventLog,
			messageStore,
			sessionStore,
			streamBus,
		});
		writer.claim();

		await writer.run({ role: "user", content: "hello" }, "tab1", "hello");

		const eventTypes = frames.map((f) => f.event);
		expect(eventTypes).toContain("user.message");
		expect(eventTypes).toContain("session.created");
		expect(eventTypes).toContain("session.done");
	});

	test("commits attachments to the user message and emits metadata", async () => {
		const session = sessionStore.create();
		const frames: ChatWireFrame[] = [];
		streamBus.subscribe(session.id, (f) => frames.push(f));
		const attachmentId = attachmentStore.create({
			sessionId: session.id,
			kind: "image",
			filename: "diagram.png",
			mimeType: "image/png",
			sizeBytes: 12,
			storagePath: "/tmp/diagram.png",
		});
		const attachments = [
			{
				id: attachmentId,
				filename: "diagram.png",
				mime_type: "image/png",
				size_bytes: 12,
				preview_url: `/chat/attachments/${attachmentId}/preview`,
			},
		];

		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime(),
			eventLog,
			messageStore,
			attachmentStore,
			sessionStore,
			streamBus,
		});
		writer.claim();
		const sdkMessage = {
			role: "user" as const,
			content: [
				{
					type: "image",
					source: { type: "base64", media_type: "image/png", data: "RAW_BASE64_PAYLOAD" },
				},
				{ type: "text", text: "describe this" },
			],
		} as Parameters<ChatSessionWriter["run"]>[0];

		await writer.run(sdkMessage, "tab1", "describe this", {
			attachments,
			transcriptContent: buildUserTranscriptContent("describe this", attachments),
		});

		const userFrame = frames.find((frame) => frame.event === "user.message");
		expect(userFrame?.event).toBe("user.message");
		if (userFrame?.event !== "user.message") return;
		expect(userFrame.attachments).toEqual(attachments);

		const userRow = messageStore.getById(userFrame.message_id);
		expect(userRow?.content_json).toBe(JSON.stringify(buildUserTranscriptContent("describe this", attachments)));
		expect(userRow?.content_json).not.toContain("RAW_BASE64_PAYLOAD");
		expect(attachmentStore.getById(attachmentId)?.message_id).toBe(userFrame.message_id);
	});

	test("writer sets isActive during run", async () => {
		const session = sessionStore.create();
		let wasActive = false;

		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime({
				runForChat: async (_k, _m, opts) => {
					wasActive = writer.isActive;
					opts.onSdkEvent({
						type: "result",
						subtype: "success",
						result: "ok",
						stop_reason: "end_turn",
						total_cost_usd: 0,
						usage: {},
						modelUsage: {},
						duration_ms: 0,
						num_turns: 1,
					});
					return {
						text: "ok",
						sessionId: "s1",
						cost: { totalUsd: 0, inputTokens: 0, outputTokens: 0, modelUsage: {} },
						durationMs: 0,
					};
				},
			}),
			eventLog,
			messageStore,
			sessionStore,
			streamBus,
		});
		writer.claim();

		await writer.run({ role: "user", content: "test" }, "t1", "test");
		expect(wasActive).toBe(true);
		expect(writer.isActive).toBe(false);
	});

	test("error during execution emits session.error", async () => {
		const session = sessionStore.create();
		const frames: ChatWireFrame[] = [];
		streamBus.subscribe(session.id, (f) => frames.push(f));

		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime({
				runForChat: async () => {
					throw new Error("SDK crashed");
				},
			}),
			eventLog,
			messageStore,
			sessionStore,
			streamBus,
		});
		writer.claim();

		await writer.run({ role: "user", content: "fail" }, "t1", "fail");

		const eventTypes = frames.map((f) => f.event);
		expect(eventTypes).toContain("session.error");
	});

	test("non-success SDK result does not commit a successful assistant message", async () => {
		const session = sessionStore.create();
		const frames: ChatWireFrame[] = [];
		streamBus.subscribe(session.id, (f) => frames.push(f));

		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime({
				runForChat: async (_key, _message, opts) => {
					opts.onSdkEvent({
						type: "result",
						subtype: "error_during_execution",
						errors: ["Provider failed"],
						total_cost_usd: 0.02,
						usage: { input_tokens: 10, output_tokens: 0 },
						duration_ms: 15,
						num_turns: 1,
					});
					return {
						text: "",
						sessionId: "sdk-1",
						cost: { totalUsd: 0.02, inputTokens: 10, outputTokens: 0, modelUsage: {} },
						durationMs: 15,
					};
				},
			}),
			eventLog,
			messageStore,
			sessionStore,
			timelineStore,
			streamBus,
		});
		writer.claim();

		await writer.run({ role: "user", content: "fail" }, "t1", "fail");

		const messages = messageStore.getBySession(session.id);
		expect(messages.map((message) => message.role)).toEqual(["user"]);
		expect(frames.some((frame) => frame.event === "session.error")).toBe(true);
		expect(frames.some((frame) => frame.event === "session.done")).toBe(false);
		const timelines = timelineStore.getDetailsBySession(session.id);
		expect(timelines[0]?.status).toBe("error");
		expect(timelines[0]?.assistant_message_id).toBeNull();
	});

	test("multi-subscriber fan-out delivers to all", async () => {
		const session = sessionStore.create();
		const frames1: ChatWireFrame[] = [];
		const frames2: ChatWireFrame[] = [];
		streamBus.subscribe(session.id, (f) => frames1.push(f));
		streamBus.subscribe(session.id, (f) => frames2.push(f));

		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime(),
			eventLog,
			messageStore,
			sessionStore,
			streamBus,
		});
		writer.claim();

		await writer.run({ role: "user", content: "multi" }, "t1", "multi");

		expect(frames1.length).toBeGreaterThan(0);
		expect(frames1.length).toBe(frames2.length);
	});

	test("seq strictly increases across events", async () => {
		const session = sessionStore.create();
		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime(),
			eventLog,
			messageStore,
			sessionStore,
			streamBus,
		});
		writer.claim();

		await writer.run({ role: "user", content: "seq test" }, "t1", "seq test");

		const events = eventLog.drain(session.id, 0);
		for (let i = 1; i < events.length; i++) {
			expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
		}
	});

	test("getActiveWriter returns undefined after completion", async () => {
		const session = sessionStore.create();
		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime(),
			eventLog,
			messageStore,
			sessionStore,
			streamBus,
		});
		writer.claim();

		await writer.run({ role: "user", content: "test" }, "t1", "test");
		expect(getActiveWriter(session.id)).toBeUndefined();
	});

	test("claim() registers writer in activeWriters synchronously", () => {
		const session = sessionStore.create();
		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime(),
			eventLog,
			messageStore,
			sessionStore,
			streamBus,
		});
		expect(getActiveWriter(session.id)).toBeUndefined();
		writer.claim();
		expect(getActiveWriter(session.id)).toBe(writer);
		expect(writer.isActive).toBe(true);
	});

	test("run() throws if claim() not called first", async () => {
		const session = sessionStore.create();
		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime(),
			eventLog,
			messageStore,
			sessionStore,
			streamBus,
		});
		await expect(writer.run({ role: "user", content: "test" }, "t1", "test")).rejects.toThrow(
			"Writer must be claimed before run()",
		);
	});

	test("session.created frame has seq assigned by writer emitFrame", async () => {
		const session = sessionStore.create();
		const frames: ChatWireFrame[] = [];
		streamBus.subscribe(session.id, (f) => frames.push(f));

		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime(),
			eventLog,
			messageStore,
			sessionStore,
			streamBus,
		});
		writer.claim();

		await writer.run({ role: "user", content: "seq check" }, "t1", "seq check");

		const createdFrame = frames.find((f) => f.event === "session.created");
		expect(createdFrame).toBeDefined();
		if (createdFrame?.event === "session.created") {
			expect(createdFrame.seq).toBeGreaterThan(0);
			// The seq in the payload must match the persisted event log seq
			const events = eventLog.drain(session.id, 0);
			const createdEvent = events.find((e) => e.event_type === "session.created");
			expect(createdEvent?.seq).toBe(createdFrame.seq);
		}
	});

	test("persists completed run timeline with committed assistant id", async () => {
		const session = sessionStore.create();
		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime(),
			eventLog,
			messageStore,
			sessionStore,
			timelineStore,
			streamBus,
		});
		writer.claim();

		await writer.run({ role: "user", content: "timeline" }, "t1", "timeline");

		const timelines = timelineStore.getDetailsBySession(session.id);
		expect(timelines).toHaveLength(1);
		expect(timelines[0]?.status).toBe("completed");
		expect(timelines[0]?.assistant_message_id).not.toBeNull();
		expect(timelines[0]?.summary.status).toBe("completed");
	});

	test("passes durable page context into the chat runtime", async () => {
		const session = sessionStore.create();
		let capturedContext: string | undefined;
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
				path: "profile.html",
				title: "Profile Page",
			},
		});
		eventLog.append(session.id, null, 3, "message.tool_call_result", {
			event: "message.tool_call_result",
			tool_call_id: "tool-1",
			tool_name: "phantom_create_page",
			status: "success",
			output: JSON.stringify({
				path: "profile.html",
				url: "http://127.0.0.1:3112/ui/profile.html",
			}),
		});

		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime({
				runForChat: async (_key, _message, opts) => {
					capturedContext = opts.sessionContext;
					opts.onSdkEvent({
						type: "result",
						subtype: "success",
						result: "ok",
						stop_reason: "end_turn",
						total_cost_usd: 0,
						usage: {},
						modelUsage: {},
						duration_ms: 0,
						num_turns: 1,
					});
					return {
						text: "ok",
						sessionId: "sdk-1",
						cost: { totalUsd: 0, inputTokens: 0, outputTokens: 0, modelUsage: {} },
						durationMs: 0,
					};
				},
			}),
			eventLog,
			messageStore,
			sessionStore,
			streamBus,
		});
		writer.claim();

		await writer.run({ role: "user", content: "give me the page link" }, "t1", "give me the page link");

		expect(capturedContext).toContain("Profile Page");
		expect(capturedContext).toContain("http://127.0.0.1:3112/ui/profile.html");
	});

	test("persists errored run timeline without committing assistant id", async () => {
		const session = sessionStore.create();
		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime({
				runForChat: async () => {
					throw new Error("SDK crashed");
				},
			}),
			eventLog,
			messageStore,
			sessionStore,
			timelineStore,
			streamBus,
		});
		writer.claim();

		await writer.run({ role: "user", content: "fail" }, "t1", "fail");

		const timelines = timelineStore.getDetailsBySession(session.id);
		expect(timelines[0]?.status).toBe("error");
		expect(timelines[0]?.assistant_message_id).toBeNull();
		expect(timelines[0]?.summary.errors[0]?.message).toBe("SDK crashed");
	});

	test("persists aborted run timeline as one aborted terminal", async () => {
		const session = sessionStore.create();
		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime: mockRuntime({
				runForChat: async () => {
					const err = new Error("aborted");
					err.name = "AbortError";
					throw err;
				},
			}),
			eventLog,
			messageStore,
			sessionStore,
			timelineStore,
			streamBus,
		});
		writer.claim();

		await writer.run({ role: "user", content: "stop" }, "t1", "stop");

		const timelines = timelineStore.getDetailsBySession(session.id);
		expect(timelines[0]?.status).toBe("aborted");
		expect(timelines[0]?.summary.status).toBe("aborted");
		expect(timelines[0]?.summary.currentLabel).toBe("Run stopped.");
	});
});
