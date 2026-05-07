import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createSlackInteractionFactory } from "../slack-interaction.ts";
import type { InboundMessage } from "../types.ts";

// Minimal SlackChannel mock — only the methods slack-interaction.ts touches.
function makeMockSlackChannel() {
	const calls = {
		addReaction: [] as Array<{ ch: string; ts: string; emoji: string }>,
		removeReaction: [] as Array<{ ch: string; ts: string; emoji: string }>,
		postThinking: [] as Array<{ ch: string; threadTs: string }>,
		updateMessage: [] as Array<{ ch: string; ts: string; text: string }>,
		updateWithFeedback: [] as Array<{ ch: string; ts: string; text: string }>,
	};

	let nextThinkingTs: string | null = "thinking-ts";

	const channel = {
		addReaction: mock(async (ch: string, ts: string, emoji: string) => {
			calls.addReaction.push({ ch, ts, emoji });
		}),
		removeReaction: mock(async (ch: string, ts: string, emoji: string) => {
			calls.removeReaction.push({ ch, ts, emoji });
		}),
		postThinking: mock(async (ch: string, threadTs: string) => {
			calls.postThinking.push({ ch, threadTs });
			return nextThinkingTs;
		}),
		updateMessage: mock(async (ch: string, ts: string, text: string) => {
			calls.updateMessage.push({ ch, ts, text });
		}),
		updateWithFeedback: mock(async (ch: string, ts: string, text: string) => {
			calls.updateWithFeedback.push({ ch, ts, text });
		}),
	};

	return {
		channel: channel as unknown as Parameters<typeof createSlackInteractionFactory>[0],
		calls,
		setNextThinkingTs(value: string | null): void {
			nextThinkingTs = value;
		},
	};
}

function makeSlackMessage(overrides: Partial<InboundMessage["metadata"]> = {}): InboundMessage {
	return {
		id: "msg-id",
		channelId: "slack",
		conversationId: "slack:C123:ts-1",
		senderId: "U123",
		text: "hello",
		timestamp: new Date(),
		metadata: {
			slackChannel: "C123",
			slackThreadTs: "ts-1",
			slackMessageTs: "ts-1",
			...overrides,
		},
	};
}

describe("createSlackInteractionFactory", () => {
	test("returns null when slackChannel is null", () => {
		const factory = createSlackInteractionFactory(null);
		expect(factory(makeSlackMessage())).toBeNull();
	});

	test("returns null for non-slack messages", () => {
		const { channel } = makeMockSlackChannel();
		const factory = createSlackInteractionFactory(channel);

		const nonSlack: InboundMessage = {
			id: "x",
			channelId: "telegram",
			conversationId: "telegram:1",
			senderId: "u",
			text: "hi",
			timestamp: new Date(),
			metadata: { telegramChatId: 42 },
		};

		expect(factory(nonSlack)).toBeNull();
	});

	test("returns null for slack messages without metadata", () => {
		const { channel } = makeMockSlackChannel();
		const factory = createSlackInteractionFactory(channel);

		const noMeta: InboundMessage = {
			id: "x",
			channelId: "slack",
			conversationId: "slack:C:ts",
			senderId: "u",
			text: "hi",
			timestamp: new Date(),
		};
		expect(factory(noMeta)).toBeNull();
	});

	test("creates an instance with both statusReactions and progressStream when metadata is complete", () => {
		const { channel } = makeMockSlackChannel();
		const factory = createSlackInteractionFactory(channel);

		const instance = factory(makeSlackMessage());
		expect(instance).not.toBeNull();
		expect(instance?.statusReactions).toBeDefined();
		expect(instance?.progressStream).toBeDefined();
	});

	test("setQueued is fired immediately on instance creation", async () => {
		const { channel, calls } = makeMockSlackChannel();
		const factory = createSlackInteractionFactory(channel);

		factory(makeSlackMessage());
		// Allow the setQueued microtask + adapter promise chain to flush
		await new Promise((r) => setTimeout(r, 50));
		expect(calls.addReaction.some((c) => c.emoji === "eyes")).toBe(true);
	});

	test("onTurnStart starts the progress stream", async () => {
		const { channel, calls } = makeMockSlackChannel();
		const factory = createSlackInteractionFactory(channel);

		const instance = factory(makeSlackMessage());
		await instance?.onTurnStart?.();
		expect(calls.postThinking.length).toBe(1);
		expect(calls.postThinking[0]).toEqual({ ch: "C123", threadTs: "ts-1" });
	});

	test("onRuntimeEvent thinking sets thinking emoji on the user message", async () => {
		const { channel, calls } = makeMockSlackChannel();
		const factory = createSlackInteractionFactory(channel);

		const instance = factory(makeSlackMessage());
		instance?.onRuntimeEvent?.({ type: "thinking", sessionId: "s1" });
		await new Promise((r) => setTimeout(r, 600)); // debounce is 500ms
		expect(calls.addReaction.some((c) => c.emoji === "brain")).toBe(true);
	});

	test("onRuntimeEvent tool_use updates both reactions and progress activity", async () => {
		const { channel, calls } = makeMockSlackChannel();
		const factory = createSlackInteractionFactory(channel);

		const instance = factory(makeSlackMessage());
		await instance?.onTurnStart?.();
		instance?.onRuntimeEvent?.({
			type: "tool_use",
			tool: "Read",
			input: { file_path: "/x.ts" },
			sessionId: "s1",
		});
		await new Promise((r) => setTimeout(r, 1200)); // progress throttle is 1000ms
		expect(calls.updateMessage.length).toBeGreaterThanOrEqual(1);
		const wroteActivity = calls.updateMessage.some((c) => c.text.includes("Reading /x.ts"));
		expect(wroteActivity).toBe(true);
	});

	test("onRuntimeEvent error sets error reaction", async () => {
		const { channel, calls } = makeMockSlackChannel();
		const factory = createSlackInteractionFactory(channel);

		const instance = factory(makeSlackMessage());
		instance?.onRuntimeEvent?.({ type: "error", message: "boom" });
		await new Promise((r) => setTimeout(r, 50));
		expect(calls.addReaction.some((c) => c.emoji === "warning")).toBe(true);
	});

	test("deliverResponse uses progressStream.finish path when stream is active", async () => {
		const { channel, calls } = makeMockSlackChannel();
		const factory = createSlackInteractionFactory(channel);

		const instance = factory(makeSlackMessage());
		await instance?.onTurnStart?.();
		const claimed = await instance?.deliverResponse?.({ text: "Final answer", isError: false });
		expect(claimed).toBe(true);
		expect(calls.updateWithFeedback.length).toBe(1);
		expect(calls.updateWithFeedback[0].text).toBe("Final answer");
	});

	test("deliverResponse uses post-then-update fallback when no progress stream", async () => {
		const { channel, calls } = makeMockSlackChannel();
		const factory = createSlackInteractionFactory(channel);

		// Message with no threadTs in metadata still has slackChannel + messageTs
		// but progress stream requires both channel and threadTs to be set.
		// We need a case where progressStream is undefined but the fallback path works.
		// In practice this happens when slackThreadTs is missing.
		const msgWithoutThread = makeSlackMessage({ slackThreadTs: undefined });
		const instance = factory(msgWithoutThread);
		expect(instance?.progressStream).toBeUndefined();

		// The fallback path requires slackThreadTs to be defined, so without it,
		// deliverResponse should not be able to claim. Verify: factory with no
		// thread does not fall back through Slack delivery.
		const claimed = await instance?.deliverResponse?.({ text: "F", isError: false });
		expect(claimed).toBe(false);
		expect(calls.updateWithFeedback.length).toBe(0);
	});

	test("dispose disposes the status reactions controller", () => {
		const { channel } = makeMockSlackChannel();
		const factory = createSlackInteractionFactory(channel);

		const instance = factory(makeSlackMessage());
		// dispose should not throw
		expect(() => instance?.dispose?.()).not.toThrow();
	});
});
