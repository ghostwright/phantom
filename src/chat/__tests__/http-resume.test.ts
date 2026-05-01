import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentResponse } from "../../agent/events.ts";
import { MIGRATIONS } from "../../db/schema.ts";
import { createSession } from "../../ui/session.ts";
import { ChatAttachmentStore } from "../attachment-store.ts";
import { ChatEventLog } from "../event-log.ts";
import { createChatHandler } from "../http.ts";
import { ChatMessageStore } from "../message-store.ts";
import { ChatSessionStore } from "../session-store.ts";
import { StreamBus } from "../stream-bus.ts";
import type { ChatWireFrame } from "../types.ts";
import { ChatSessionWriter } from "../writer.ts";

type ParsedSseFrame = {
	id: number | null;
	event: string;
	data: Record<string, unknown>;
};

let db: Database;
let eventLog: ChatEventLog;
let messageStore: ChatMessageStore;
let sessionStore: ChatSessionStore;
let streamBus: StreamBus;
let handler: (req: Request) => Promise<Response | null>;
let sessionToken: string;

function makeAuthReq(path: string, opts: RequestInit = {}): Request {
	return new Request(`http://localhost:3100${path}`, {
		...opts,
		headers: {
			...(opts.headers ?? {}),
			Cookie: `phantom_session=${sessionToken}`,
			"Content-Type": "application/json",
		},
	});
}

function parseSseFrames(text: string): ParsedSseFrame[] {
	const frames: ParsedSseFrame[] = [];
	for (const chunk of text.split("\n\n")) {
		const lines = chunk.split("\n");
		const idLine = lines.find((line) => line.startsWith("id: "));
		const eventLine = lines.find((line) => line.startsWith("event: "));
		const dataLine = lines.find((line) => line.startsWith("data: "));
		if (!eventLine || !dataLine) continue;
		frames.push({
			id: idLine ? Number.parseInt(idLine.slice("id: ".length), 10) : null,
			event: eventLine.slice("event: ".length),
			data: JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>,
		});
	}
	return frames;
}

beforeEach(() => {
	db = new Database(":memory:");
	for (const sql of MIGRATIONS) {
		db.run(sql);
	}

	const { sessionToken: token } = createSession();
	sessionToken = token;

	eventLog = new ChatEventLog(db);
	messageStore = new ChatMessageStore(db);
	sessionStore = new ChatSessionStore(db);
	streamBus = new StreamBus();

	const mockRuntime = {} as Parameters<typeof createChatHandler>[0]["runtime"];
	handler = createChatHandler({
		runtime: mockRuntime,
		sessionStore,
		messageStore,
		eventLog,
		attachmentStore: new ChatAttachmentStore(db),
		streamBus,
		getBootstrapData: () => ({ agent_name: "TestAgent", evolution_gen: 0 }),
	});
});

afterEach(() => {
	db.close();
});

function defaultAgentResponse(): AgentResponse {
	return {
		text: "ok",
		sessionId: "sdk-resume",
		cost: { totalUsd: 0, inputTokens: 0, outputTokens: 0, modelUsage: {} },
		durationMs: 1,
	};
}

function createPendingRuntime(): {
	runtime: Parameters<typeof createChatHandler>[0]["runtime"];
	resolveRun: (response?: AgentResponse) => void;
} {
	type Runtime = Parameters<typeof createChatHandler>[0]["runtime"];
	let resolveRunPromise: ((response: AgentResponse) => void) | null = null;
	const runForChat: Runtime["runForChat"] = async () =>
		await new Promise<AgentResponse>((resolve) => {
			resolveRunPromise = resolve;
		});
	const judgeQuery: Runtime["judgeQuery"] = async (options) => ({
		verdict: "pass",
		confidence: 1,
		reasoning: "test title",
		data: options.schema.parse({ title: "Resume Race" }),
		model: "test",
		inputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		durationMs: 0,
	});

	return {
		runtime: {
			runForChat,
			judgeQuery,
		} as Runtime,
		resolveRun(response = defaultAgentResponse()) {
			if (!resolveRunPromise) {
				throw new Error("Runtime was not started");
			}
			resolveRunPromise(response);
		},
	};
}

describe("Chat HTTP resume", () => {
	test("buffers live frames that arrive while replay catches up", async () => {
		const session = sessionStore.create("active resume race");
		const { runtime, resolveRun } = createPendingRuntime();
		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime,
			eventLog,
			messageStore,
			sessionStore,
			streamBus,
		});
		writer.claim();
		const runPromise = writer.run({ role: "user", content: "hello" }, "tab-1", "hello");

		const originalDrain = eventLog.drain.bind(eventLog);
		let injectedRaceFrame = false;
		const drainWithRace = ((targetSessionId: string, afterSeq: number, limit?: number) => {
			const events = originalDrain(targetSessionId, afterSeq, limit);
			if (targetSessionId === session.id && afterSeq >= 1 && events.length === 0 && !injectedRaceFrame) {
				injectedRaceFrame = true;
				const seq = afterSeq + 1;
				const frame: ChatWireFrame = {
					event: "message.text_delta",
					text_block_id: "text-race",
					delta: "late-race-frame",
				};
				eventLog.append(session.id, null, seq, frame.event, frame);
				streamBus.publish(session.id, frame, seq);
			}
			return events;
		}) satisfies ChatEventLog["drain"];
		eventLog.drain = drainWithRace;

		const res = await handler(
			makeAuthReq(`/chat/sessions/${session.id}/resume`, {
				method: "POST",
				body: JSON.stringify({ client_last_seq: 0 }),
			}),
		);
		if (!res) {
			throw new Error("Expected resume response");
		}

		const textPromise = res.text();
		const doneSeq = eventLog.getMaxSeq(session.id) + 1;
		const doneFrame: ChatWireFrame = {
			event: "session.done",
			session_id: session.id,
			message_id: "assistant-race",
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
			cost_usd: 0,
			duration_ms: 1,
			num_turns: 1,
		};
		eventLog.append(session.id, null, doneSeq, doneFrame.event, doneFrame);
		streamBus.publish(session.id, doneFrame, doneSeq);

		const frames = parseSseFrames(await textPromise);
		resolveRun();
		await runPromise;

		const raceFrame = frames.find(
			(frame) => frame.event === "message.text_delta" && frame.data.delta === "late-race-frame",
		);
		const caughtUp = frames.find((frame) => frame.event === "session.caught_up")?.data;

		expect(raceFrame?.id).toBe(2);
		expect(caughtUp?.up_to_seq).toBeGreaterThanOrEqual(2);
	});

	test("emits a non-persisted server restart recovery frame for incomplete replay tails", async () => {
		const session = sessionStore.create("resume test");
		const assistantMessageId = "assistant-1";
		eventLog.append(session.id, null, 1, "user.message", {
			event: "user.message",
			message_id: "user-1",
			text: "hello",
			attachments: [],
			sent_at: "2026-04-30T00:00:00.000Z",
			source_tab_id: "tab-1",
		});
		eventLog.append(session.id, assistantMessageId, 2, "message.assistant_start", {
			event: "message.assistant_start",
			message_id: assistantMessageId,
			parent_tool_use_id: null,
		});
		eventLog.append(session.id, assistantMessageId, 3, "message.text_delta", {
			event: "message.text_delta",
			text_block_id: "text-1",
			delta: "partial",
		});

		const res = await handler(
			makeAuthReq(`/chat/sessions/${session.id}/resume`, {
				method: "POST",
				body: JSON.stringify({ client_last_seq: 0 }),
			}),
		);
		if (!res) {
			throw new Error("Expected resume response");
		}

		expect(res.status).toBe(200);
		const text = await res.text();
		const frames = parseSseFrames(text);
		const eventTypes = frames.map((frame) => frame.event);
		const recovery = frames.find((frame) => frame.event === "session.error")?.data;
		const syntheticFrames = frames.filter(
			(frame) =>
				frame.event === "session.resumed" || frame.event === "session.caught_up" || frame.event === "session.error",
		);

		expect(eventTypes).toContain("session.resumed");
		expect(eventTypes).toContain("session.caught_up");
		expect(syntheticFrames.every((frame) => frame.id === null)).toBe(true);
		expect(recovery).toBeDefined();
		if (!recovery) {
			throw new Error("Expected recovery frame");
		}
		expect(recovery.subtype).toBe("server_restart");
		expect(recovery.recoverable).toBe(true);
		expect(recovery.message_id).toBeNull();
		expect(recovery.cost_usd).toBe(0);
		expect(recovery.duration_ms).toBe(0);
		expect(messageStore.getBySession(session.id)).toHaveLength(0);
		expect(eventLog.drain(session.id, 0).map((evt) => evt.event_type)).not.toContain("session.error");
	});

	test("does not emit recovery for benign post-terminal suggestion events", async () => {
		const session = sessionStore.create("completed suggestion");
		eventLog.append(session.id, null, 1, "message.assistant_start", {
			event: "message.assistant_start",
			message_id: "assistant-1",
			parent_tool_use_id: null,
		});
		eventLog.append(session.id, null, 2, "session.done", {
			event: "session.done",
			session_id: session.id,
			message_id: "assistant-1",
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
			cost_usd: 0,
			duration_ms: 1,
			num_turns: 1,
		});
		eventLog.append(session.id, null, 3, "session.suggestion", {
			event: "session.suggestion",
			session_id: session.id,
			title: "Follow up",
		});

		const res = await handler(
			makeAuthReq(`/chat/sessions/${session.id}/resume`, {
				method: "POST",
				body: JSON.stringify({ client_last_seq: 0 }),
			}),
		);
		if (!res) {
			throw new Error("Expected resume response");
		}

		const frames = parseSseFrames(await res.text());
		expect(frames.map((frame) => frame.event)).toContain("session.suggestion");
		expect(frames.find((frame) => frame.event === "session.error")).toBeUndefined();
		expect(frames.find((frame) => frame.event === "session.caught_up")?.data.up_to_seq).toBe(3);
	});

	test("emits recovery when an active writer disappears during replay without terminal", async () => {
		const session = sessionStore.create("disappearing writer");
		const { runtime, resolveRun } = createPendingRuntime();
		const writer = new ChatSessionWriter({
			sessionId: session.id,
			runtime,
			eventLog,
			messageStore,
			sessionStore,
			streamBus,
		});
		writer.claim();
		const runPromise = writer.run({ role: "user", content: "hello" }, "tab-1", "hello");

		const originalDrain = eventLog.drain.bind(eventLog);
		let disappeared = false;
		eventLog.drain = ((targetSessionId: string, afterSeq: number, limit?: number) => {
			const events = originalDrain(targetSessionId, afterSeq, limit);
			if (targetSessionId === session.id && events.length > 0 && !disappeared) {
				disappeared = true;
				Reflect.set(writer, "running", false);
			}
			return events;
		}) satisfies ChatEventLog["drain"];

		const res = await handler(
			makeAuthReq(`/chat/sessions/${session.id}/resume`, {
				method: "POST",
				body: JSON.stringify({ client_last_seq: 0 }),
			}),
		);
		if (!res) {
			throw new Error("Expected resume response");
		}

		const frames = parseSseFrames(await res.text());
		const recovery = frames.find((frame) => frame.event === "session.error")?.data;
		expect(frames.find((frame) => frame.event === "session.resumed")?.data.writer_active).toBe(true);
		expect(recovery?.subtype).toBe("server_restart");
		expect(recovery?.message_id).toBeNull();
		expect(frames.find((frame) => frame.event === "session.error")?.id).toBeNull();

		resolveRun();
		await runPromise;
	});

	test("replays more than the default event-log page before caught_up", async () => {
		const session = sessionStore.create("large replay test");
		for (let seq = 1; seq <= 5005; seq++) {
			eventLog.append(session.id, null, seq, "message.text_delta", {
				event: "message.text_delta",
				text_block_id: "text-1",
				delta: `chunk-${seq}`,
			});
		}

		const res = await handler(
			makeAuthReq(`/chat/sessions/${session.id}/resume`, {
				method: "POST",
				body: JSON.stringify({ client_last_seq: 0 }),
			}),
		);
		if (!res) {
			throw new Error("Expected resume response");
		}

		const frames = parseSseFrames(await res.text());
		const replayFrames = frames.filter((frame) => frame.event === "message.text_delta");
		const caughtUp = frames.find((frame) => frame.event === "session.caught_up")?.data;

		expect(replayFrames).toHaveLength(5005);
		expect(replayFrames.at(-1)?.id).toBe(5005);
		expect(caughtUp?.up_to_seq).toBe(5005);
	});
});
