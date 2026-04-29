import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { ChatEventLog } from "../event-log.ts";
import { ChatMessageStore } from "../message-store.ts";
import { ChatSessionStore } from "../session-store.ts";
import { StreamBus } from "../stream-bus.ts";
import type { ChatWireFrame } from "../types.ts";
import { ChatSessionWriter, getActiveWriter } from "../writer.ts";

let db: Database;
let sessionStore: ChatSessionStore;
let messageStore: ChatMessageStore;
let eventLog: ChatEventLog;
let streamBus: StreamBus;

beforeEach(() => {
	db = new Database(":memory:");
	for (const sql of MIGRATIONS) {
		db.run(sql);
	}
	sessionStore = new ChatSessionStore(db);
	messageStore = new ChatMessageStore(db);
	eventLog = new ChatEventLog(db);
	streamBus = new StreamBus();
});

afterEach(() => {
	db.close();
});

function mockRuntime(overrides?: {
	runForChat?: (
		key: string,
		msg: unknown,
		opts: { signal: AbortSignal; onSdkEvent: (msg: unknown) => void },
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
});
