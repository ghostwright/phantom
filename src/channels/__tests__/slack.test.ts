import { beforeEach, describe, expect, mock, test } from "bun:test";
import { SlackChannel, type SlackChannelConfig } from "../slack.ts";

// Mock the Slack Bolt App class
const mockStart = mock(() => Promise.resolve());
const mockStop = mock(() => Promise.resolve());
const mockAuthTest = mock(() => Promise.resolve({ user_id: "U_BOT123" }));
const mockPostMessage = mock(() => Promise.resolve({ ts: "1234567890.123456" }));
const mockChatUpdate = mock(() => Promise.resolve({ ok: true }));
const mockReactionsAdd = mock(() => Promise.resolve({ ok: true }));
const mockReactionsRemove = mock(() => Promise.resolve({ ok: true }));
const mockConversationsOpen = mock(() => Promise.resolve({ channel: { id: "D_REJECT_DM" } }));
const mockFilesUploadV2 = mock(() => Promise.resolve({ ok: true }));

type EventHandler = (...args: unknown[]) => Promise<void>;
const eventHandlers = new Map<string, EventHandler>();
const actionHandlers = new Map<string, EventHandler>();

const MockApp = mock(() => ({
	start: mockStart,
	stop: mockStop,
	event: (name: string, handler: EventHandler) => {
		eventHandlers.set(name, handler);
	},
	action: (pattern: string | RegExp, handler: EventHandler) => {
		const key = pattern instanceof RegExp ? pattern.source : pattern;
		actionHandlers.set(key, handler);
	},
	client: {
		auth: { test: mockAuthTest },
		chat: {
			postMessage: mockPostMessage,
			update: mockChatUpdate,
		},
		conversations: {
			open: mockConversationsOpen,
		},
		reactions: {
			add: mockReactionsAdd,
			remove: mockReactionsRemove,
		},
		files: {
			uploadV2: mockFilesUploadV2,
		},
	},
}));

// Replace the import with our mock
mock.module("@slack/bolt", () => ({
	App: MockApp,
}));

const testConfig: SlackChannelConfig = {
	botToken: "xoxb-test-token",
	appToken: "xapp-test-token",
};

async function invokeHandler(name: string, payload: unknown): Promise<void> {
	const handler = eventHandlers.get(name);
	if (handler) await handler(payload);
}

describe("SlackChannel", () => {
	beforeEach(() => {
		eventHandlers.clear();
		actionHandlers.clear();
		mockStart.mockClear();
		mockStop.mockClear();
		mockAuthTest.mockClear();
		mockPostMessage.mockClear();
		mockChatUpdate.mockClear();
		mockConversationsOpen.mockClear();
		mockReactionsAdd.mockClear();
		mockReactionsRemove.mockClear();
		mockFilesUploadV2.mockClear();
	});

	test("has correct id and capabilities", () => {
		const channel = new SlackChannel(testConfig);
		expect(channel.id).toBe("slack");
		expect(channel.name).toBe("Slack");
		expect(channel.capabilities.threads).toBe(true);
		expect(channel.capabilities.richText).toBe(true);
	});

	test("starts disconnected", () => {
		const channel = new SlackChannel(testConfig);
		expect(channel.isConnected()).toBe(false);
		expect(channel.getConnectionState()).toBe("disconnected");
	});

	test("connect transitions to connected state", async () => {
		const channel = new SlackChannel(testConfig);
		await channel.connect();
		expect(channel.isConnected()).toBe(true);
		expect(channel.getConnectionState()).toBe("connected");
		expect(mockStart).toHaveBeenCalledTimes(1);
	});

	test("disconnect transitions to disconnected state", async () => {
		const channel = new SlackChannel(testConfig);
		await channel.connect();
		await channel.disconnect();
		expect(channel.isConnected()).toBe(false);
		expect(mockStop).toHaveBeenCalledTimes(1);
	});

	test("registers event handlers on connect", async () => {
		const channel = new SlackChannel(testConfig);
		await channel.connect();
		expect(eventHandlers.has("app_mention")).toBe(true);
		expect(eventHandlers.has("message")).toBe(true);
		expect(eventHandlers.has("reaction_added")).toBe(true);
	});

	test("routes app_mention to message handler", async () => {
		const channel = new SlackChannel(testConfig);
		let receivedText = "";
		let receivedConvId = "";

		channel.onMessage(async (msg) => {
			receivedText = msg.text;
			receivedConvId = msg.conversationId;
		});

		await channel.connect();
		expect(eventHandlers.has("app_mention")).toBe(true);

		await invokeHandler("app_mention", {
			event: {
				text: "<@U_BOT123> Hello Phantom",
				user: "U_USER1",
				channel: "C_CHANNEL1",
				ts: "1234567890.000001",
			},
			client: {},
		});

		expect(receivedText).toBe("Hello Phantom");
		expect(receivedConvId).toBe("slack:C_CHANNEL1:1234567890.000001");
	});

	test("routes DM messages to message handler", async () => {
		const channel = new SlackChannel(testConfig);
		let receivedText = "";
		let receivedConvId = "";

		channel.onMessage(async (msg) => {
			receivedText = msg.text;
			receivedConvId = msg.conversationId;
		});

		await channel.connect();
		expect(eventHandlers.has("message")).toBe(true);

		await invokeHandler("message", {
			event: {
				text: "Hello via DM",
				user: "U_USER1",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000002",
			},
		});

		expect(receivedText).toBe("Hello via DM");
		// DMs are thread-scoped: same format as channels (slack:<channel>:<threadTs>)
		expect(receivedConvId).toBe("slack:D_DM1:1234567890.000002");
	});

	test("ignores bot messages", async () => {
		const channel = new SlackChannel(testConfig);
		let handlerCalled = false;

		channel.onMessage(async () => {
			handlerCalled = true;
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Bot message",
				bot_id: "B_BOT1",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000003",
			},
		});

		expect(handlerCalled).toBe(false);
	});

	test("ignores messages with non-file subtypes", async () => {
		const channel = new SlackChannel(testConfig);
		let handlerCalled = false;

		channel.onMessage(async () => {
			handlerCalled = true;
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Edited message",
				subtype: "message_changed",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000004",
			},
		});

		expect(handlerCalled).toBe(false);
	});

	test("ignores self-messages", async () => {
		const channel = new SlackChannel(testConfig);
		let handlerCalled = false;

		channel.onMessage(async () => {
			handlerCalled = true;
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "My own message",
				user: "U_BOT123",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000005",
			},
		});

		expect(handlerCalled).toBe(false);
	});

	test("only handles DMs, not channel messages via message event", async () => {
		const channel = new SlackChannel(testConfig);
		let handlerCalled = false;

		channel.onMessage(async () => {
			handlerCalled = true;
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Channel message without mention",
				user: "U_USER1",
				channel: "C_CHANNEL1",
				channel_type: "channel",
				ts: "1234567890.000006",
			},
		});

		expect(handlerCalled).toBe(false);
	});

	test("tracks positive reactions", async () => {
		const channel = new SlackChannel(testConfig);
		let capturedPositive = "unset";

		channel.onReaction((event) => {
			capturedPositive = event.isPositive ? "yes" : "no";
		});

		await channel.connect();

		await invokeHandler("reaction_added", {
			event: {
				reaction: "thumbsup",
				user: "U_USER1",
				item: { ts: "1234567890.000001", channel: "C_CHANNEL1" },
			},
		});

		expect(capturedPositive).toBe("yes");
	});

	test("tracks negative reactions", async () => {
		const channel = new SlackChannel(testConfig);
		let capturedPositive = "unset";

		channel.onReaction((event) => {
			capturedPositive = event.isPositive ? "yes" : "no";
		});

		await channel.connect();

		await invokeHandler("reaction_added", {
			event: {
				reaction: "thumbsdown",
				user: "U_USER1",
				item: { ts: "1234567890.000001", channel: "C_CHANNEL1" },
			},
		});

		expect(capturedPositive).toBe("no");
	});

	test("ignores non-feedback reactions", async () => {
		const channel = new SlackChannel(testConfig);
		let reactionEvent = null;

		channel.onReaction((event) => {
			reactionEvent = event;
		});

		await channel.connect();

		await invokeHandler("reaction_added", {
			event: {
				reaction: "eyes",
				user: "U_USER1",
				item: { ts: "1234567890.000001", channel: "C_CHANNEL1" },
			},
		});

		expect(reactionEvent).toBeNull();
	});

	test("postThinking sends a message and returns ts", async () => {
		const channel = new SlackChannel(testConfig);
		await channel.connect();

		const ts = await channel.postThinking("C_CHANNEL1", "1234567890.000001");
		expect(ts).toBe("1234567890.123456");
		expect(mockPostMessage).toHaveBeenCalledWith({
			channel: "C_CHANNEL1",
			thread_ts: "1234567890.000001",
			text: "Working on it...",
		});
	});

	test("updateMessage calls chat.update", async () => {
		const channel = new SlackChannel(testConfig);
		await channel.connect();

		await channel.updateMessage("C_CHANNEL1", "1234567890.123456", "Real response");
		expect(mockChatUpdate).toHaveBeenCalledTimes(1);
	});

	test("send posts a message to the correct channel and thread", async () => {
		const channel = new SlackChannel(testConfig);
		await channel.connect();

		const result = await channel.send("slack:C_CHANNEL1:1234567890.000001", { text: "Hello" });
		expect(result.channelId).toBe("slack");
		expect(mockPostMessage).toHaveBeenCalledWith({
			channel: "C_CHANNEL1",
			text: "Hello",
			thread_ts: "1234567890.000001",
		});
	});

	test("DM thread replies use thread-scoped conversation ID", async () => {
		const channel = new SlackChannel(testConfig);
		let receivedConvId = "";

		channel.onMessage(async (msg) => {
			receivedConvId = msg.conversationId;
		});

		await channel.connect();

		// Reply in a DM thread - should scope to the thread, not the user
		await invokeHandler("message", {
			event: {
				text: "Follow-up",
				user: "U_USER1",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000099",
				thread_ts: "1234567890.000002",
			},
		});

		expect(receivedConvId).toBe("slack:D_DM1:1234567890.000002");
	});

	test("send handles DM conversations", async () => {
		const channel = new SlackChannel(testConfig);
		await channel.connect();

		// DMs now use thread-scoped IDs: slack:<dm_channel>:<threadTs>
		await channel.send("slack:D_DM1:1234567890.000002", { text: "DM reply" });
		expect(mockPostMessage).toHaveBeenCalledWith({
			channel: "D_DM1",
			text: "DM reply",
			thread_ts: "1234567890.000002",
		});
	});
});

describe("SlackChannel file attachments", () => {
	const mockFetch = mock(() =>
		Promise.resolve({
			ok: true,
			arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
		}),
	);
	const mockBunWrite = mock(() => Promise.resolve(0));

	beforeEach(() => {
		eventHandlers.clear();
		actionHandlers.clear();
		mockStart.mockClear();
		mockAuthTest.mockClear();
		mockPostMessage.mockClear();
		mockFetch.mockClear();
		mockBunWrite.mockClear();
		globalThis.fetch = mockFetch as unknown as typeof fetch;
		Bun.write = mockBunWrite as unknown as typeof Bun.write;
	});

	const slackImageFile = {
		url_private: "https://files.slack.com/files-pri/T00/test.png",
		mimetype: "image/png",
		name: "screenshot.png",
		size: 1000,
	};

	test("processes file_share DMs with text and files", async () => {
		const channel = new SlackChannel(testConfig);
		let receivedText = "";
		let receivedAttachments: unknown[] = [];

		channel.onMessage(async (msg) => {
			receivedText = msg.text;
			receivedAttachments = msg.attachments ?? [];
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Check this image",
				subtype: "file_share",
				user: "U_USER1",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000010",
				files: [slackImageFile],
			},
		});

		expect(receivedText).toBe("Check this image");
		expect(receivedAttachments).toHaveLength(1);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	test("processes file_share DMs with files but no text", async () => {
		const channel = new SlackChannel(testConfig);
		let receivedText = "";
		let handlerCalled = false;

		channel.onMessage(async (msg) => {
			handlerCalled = true;
			receivedText = msg.text;
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "",
				subtype: "file_share",
				user: "U_USER1",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000011",
				files: [slackImageFile],
			},
		});

		expect(handlerCalled).toBe(true);
		expect(receivedText).toBe("[User sent attached files]");
	});

	test("skips non-image files and reports them in skippedFiles", async () => {
		const channel = new SlackChannel(testConfig);
		let receivedAttachments: unknown[] = [];
		let receivedSkipped: unknown[] = [];
		let receivedText = "";

		channel.onMessage(async (msg) => {
			receivedText = msg.text;
			receivedAttachments = msg.attachments ?? [];
			receivedSkipped = msg.skippedFiles ?? [];
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Here is a PDF",
				subtype: "file_share",
				user: "U_USER1",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000012",
				files: [
					{ url_private: "https://files.slack.com/doc.pdf", mimetype: "application/pdf", name: "doc.pdf", size: 500 },
				],
			},
		});

		// Text should still be processed even though the file was skipped
		expect(receivedText).toBe("Here is a PDF");
		expect(receivedAttachments).toHaveLength(0);
		expect(receivedSkipped).toHaveLength(1);
		expect(receivedSkipped[0]).toEqual({
			filename: "doc.pdf",
			reason: "unsupported_type",
			mimetype: "application/pdf",
		});
		expect(mockFetch).not.toHaveBeenCalled();
	});

	test("handles file download failure gracefully", async () => {
		const failFetch = mock(() => Promise.resolve({ ok: false, status: 403 }));
		globalThis.fetch = failFetch as unknown as typeof fetch;

		const channel = new SlackChannel(testConfig);
		let receivedText = "";
		let receivedAttachments: unknown[] = [];
		let receivedSkipped: unknown[] = [];

		channel.onMessage(async (msg) => {
			receivedText = msg.text;
			receivedAttachments = msg.attachments ?? [];
			receivedSkipped = msg.skippedFiles ?? [];
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Check this",
				subtype: "file_share",
				user: "U_USER1",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000013",
				files: [slackImageFile],
			},
		});

		// Message delivered with text, but no attachments due to download failure
		expect(receivedText).toBe("Check this");
		expect(receivedAttachments).toHaveLength(0);
		expect(receivedSkipped).toHaveLength(1);
		expect(receivedSkipped[0]).toEqual({
			filename: "screenshot.png",
			reason: "download_failed",
		});
	});

	test("still ignores message_changed subtype", async () => {
		const channel = new SlackChannel(testConfig);
		let handlerCalled = false;

		channel.onMessage(async () => {
			handlerCalled = true;
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Edited message",
				subtype: "message_changed",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000014",
			},
		});

		expect(handlerCalled).toBe(false);
	});
});

describe("SlackChannel owner access control", () => {
	const ownerConfig: SlackChannelConfig = {
		botToken: "xoxb-test-token",
		appToken: "xapp-test-token",
		ownerUserId: "U_OWNER1",
	};

	beforeEach(() => {
		eventHandlers.clear();
		actionHandlers.clear();
		mockStart.mockClear();
		mockStop.mockClear();
		mockAuthTest.mockClear();
		mockPostMessage.mockClear();
		mockChatUpdate.mockClear();
		mockConversationsOpen.mockClear();
		mockReactionsAdd.mockClear();
		mockReactionsRemove.mockClear();
		mockFilesUploadV2.mockClear();
	});

	test("allows owner DMs through", async () => {
		const channel = new SlackChannel(ownerConfig);
		let receivedText = "";

		channel.onMessage(async (msg) => {
			receivedText = msg.text;
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Hello from owner",
				user: "U_OWNER1",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000001",
			},
		});

		expect(receivedText).toBe("Hello from owner");
	});

	test("blocks non-owner DMs", async () => {
		const channel = new SlackChannel(ownerConfig);
		let handlerCalled = false;

		channel.onMessage(async () => {
			handlerCalled = true;
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Hello from stranger",
				user: "U_STRANGER",
				channel: "D_DM2",
				channel_type: "im",
				ts: "1234567890.000002",
			},
		});

		expect(handlerCalled).toBe(false);
	});

	test("sends rejection DM to non-owner", async () => {
		const channel = new SlackChannel(ownerConfig);
		channel.onMessage(async () => {});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Hello",
				user: "U_STRANGER",
				channel: "D_DM2",
				channel_type: "im",
				ts: "1234567890.000002",
			},
		});

		expect(mockConversationsOpen).toHaveBeenCalledWith({ users: "U_STRANGER" });
		expect(mockPostMessage).toHaveBeenCalledTimes(1);
		const calls = mockPostMessage.mock.calls as unknown as Array<[Record<string, unknown>]>;
		const postCall = calls[0][0];
		expect(postCall.channel).toBe("D_REJECT_DM");
		expect(postCall.text).toContain("personal AI co-worker");
	});

	test("only rejects a user once", async () => {
		const channel = new SlackChannel(ownerConfig);
		channel.onMessage(async () => {});

		await channel.connect();

		// First message from stranger
		await invokeHandler("message", {
			event: {
				text: "Hello 1",
				user: "U_STRANGER",
				channel: "D_DM2",
				channel_type: "im",
				ts: "1234567890.000003",
			},
		});

		// Second message from same stranger
		await invokeHandler("message", {
			event: {
				text: "Hello 2",
				user: "U_STRANGER",
				channel: "D_DM2",
				channel_type: "im",
				ts: "1234567890.000004",
			},
		});

		// Should only have sent one rejection DM
		expect(mockPostMessage).toHaveBeenCalledTimes(1);
	});

	test("allows owner app_mention through", async () => {
		const channel = new SlackChannel(ownerConfig);
		let receivedText = "";

		channel.onMessage(async (msg) => {
			receivedText = msg.text;
		});

		await channel.connect();

		await invokeHandler("app_mention", {
			event: {
				text: "<@U_BOT123> Help me",
				user: "U_OWNER1",
				channel: "C_CHANNEL1",
				ts: "1234567890.000005",
			},
			client: {},
		});

		expect(receivedText).toBe("Help me");
	});

	test("blocks non-owner app_mention", async () => {
		const channel = new SlackChannel(ownerConfig);
		let handlerCalled = false;

		channel.onMessage(async () => {
			handlerCalled = true;
		});

		await channel.connect();

		await invokeHandler("app_mention", {
			event: {
				text: "<@U_BOT123> Help me",
				user: "U_STRANGER",
				channel: "C_CHANNEL1",
				ts: "1234567890.000006",
			},
			client: {},
		});

		expect(handlerCalled).toBe(false);
	});

	test("allows everyone when no owner is configured", async () => {
		const channel = new SlackChannel(testConfig);
		let receivedText = "";

		channel.onMessage(async (msg) => {
			receivedText = msg.text;
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Hello from anyone",
				user: "U_ANYONE",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000007",
			},
		});

		expect(receivedText).toBe("Hello from anyone");
	});

	test("getOwnerUserId returns configured owner", () => {
		const channel = new SlackChannel(ownerConfig);
		expect(channel.getOwnerUserId()).toBe("U_OWNER1");
	});

	test("getOwnerUserId returns null when not configured", () => {
		const channel = new SlackChannel(testConfig);
		expect(channel.getOwnerUserId()).toBeNull();
	});

	test("getClient returns the Slack API client", async () => {
		const channel = new SlackChannel(testConfig);
		const client = channel.getClient();
		expect(client).toBeDefined();
		expect(client.auth).toBeDefined();
		expect(client.chat).toBeDefined();
	});

	test("setPhantomName updates rejection message", async () => {
		const channel = new SlackChannel(ownerConfig);
		channel.setPhantomName("Scout");
		channel.onMessage(async () => {});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Hello",
				user: "U_STRANGER",
				channel: "D_DM2",
				channel_type: "im",
				ts: "1234567890.000008",
			},
		});

		const calls = mockPostMessage.mock.calls as unknown as Array<[Record<string, unknown>]>;
		const postCall = calls[0][0];
		expect(postCall.text).toContain("Scout");
	});
});

describe("SlackChannel inbound text files", () => {
	beforeEach(() => {
		eventHandlers.clear();
		actionHandlers.clear();
		mockStart.mockClear();
		mockAuthTest.mockClear();
		mockPostMessage.mockClear();
		mockFilesUploadV2.mockClear();
	});

	test(".md file content injected into message text", async () => {
		const textContent = "# Plan\nDo the thing.";
		const textEncoder = new TextEncoder();
		const mockTextFetch = mock(() =>
			Promise.resolve({
				ok: true,
				arrayBuffer: () => Promise.resolve(textEncoder.encode(textContent).buffer),
			}),
		);
		globalThis.fetch = mockTextFetch as unknown as typeof fetch;

		const channel = new SlackChannel(testConfig);
		let receivedText = "";

		channel.onMessage(async (msg) => {
			receivedText = msg.text;
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Check this plan",
				subtype: "file_share",
				user: "U_USER1",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000020",
				files: [
					{
						url_private: "https://files.slack.com/files/plan.md",
						mimetype: "text/markdown",
						name: "plan.md",
						size: 100,
					},
				],
			},
		});

		expect(receivedText).toContain("Check this plan");
		expect(receivedText).toContain("# Plan");
		expect(receivedText).toContain("Do the thing.");
		expect(receivedText).toContain("--- Content of plan.md ---");
	});

	test("text + .md file combined with double-newline separator", async () => {
		const textContent = "File content here";
		const textEncoder = new TextEncoder();
		const mockCombinedFetch = mock(() =>
			Promise.resolve({
				ok: true,
				arrayBuffer: () => Promise.resolve(textEncoder.encode(textContent).buffer),
			}),
		);
		globalThis.fetch = mockCombinedFetch as unknown as typeof fetch;

		const channel = new SlackChannel(testConfig);
		let receivedText = "";

		channel.onMessage(async (msg) => {
			receivedText = msg.text;
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "User typed this",
				subtype: "file_share",
				user: "U_USER1",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000025",
				files: [
					{
						url_private: "https://files.slack.com/files/doc.md",
						mimetype: "text/markdown",
						name: "doc.md",
						size: 50,
					},
				],
			},
		});

		// User text and file content joined with double-newline separator
		expect(receivedText).toBe("User typed this\n\n--- Content of doc.md ---\nFile content here");
	});

	test("empty .md file does not leak into nonTextAttachments", async () => {
		const textEncoder = new TextEncoder();
		const mockEmptyFetch = mock(() =>
			Promise.resolve({
				ok: true,
				arrayBuffer: () => Promise.resolve(textEncoder.encode("").buffer),
			}),
		);
		globalThis.fetch = mockEmptyFetch as unknown as typeof fetch;

		const channel = new SlackChannel(testConfig);
		let receivedAttachments: unknown[] = [];
		let receivedText = "";

		channel.onMessage(async (msg) => {
			receivedText = msg.text;
			receivedAttachments = msg.attachments ?? [];
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Here is an empty file",
				subtype: "file_share",
				user: "U_USER1",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000026",
				files: [
					{
						url_private: "https://files.slack.com/files/empty.md",
						mimetype: "text/markdown",
						name: "empty.md",
						size: 0,
					},
				],
			},
		});

		// Empty text file should not appear in attachments
		expect(receivedAttachments).toHaveLength(0);
		expect(receivedText).toBe("Here is an empty file");
	});

	test("only non-text attachments remain on InboundMessage", async () => {
		const textEncoder = new TextEncoder();
		const mockMixedFetch = mock(() =>
			Promise.resolve({
				ok: true,
				arrayBuffer: () => Promise.resolve(textEncoder.encode("text content").buffer),
			}),
		);
		globalThis.fetch = mockMixedFetch as unknown as typeof fetch;
		Bun.write = mock(() => Promise.resolve(0)) as unknown as typeof Bun.write;

		const channel = new SlackChannel(testConfig);
		let receivedAttachments: unknown[] = [];

		channel.onMessage(async (msg) => {
			receivedAttachments = msg.attachments ?? [];
		});

		await channel.connect();

		await invokeHandler("message", {
			event: {
				text: "Mixed files",
				subtype: "file_share",
				user: "U_USER1",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1234567890.000021",
				files: [
					{
						url_private: "https://files.slack.com/files/img.png",
						mimetype: "image/png",
						name: "img.png",
						size: 500,
					},
					{
						url_private: "https://files.slack.com/files/notes.md",
						mimetype: "text/markdown",
						name: "notes.md",
						size: 100,
					},
				],
			},
		});

		expect(receivedAttachments).toHaveLength(1);
		expect((receivedAttachments[0] as { type: string }).type).toBe("image");
	});
});

describe("SlackChannel outbound file upload", () => {
	beforeEach(() => {
		eventHandlers.clear();
		actionHandlers.clear();
		mockStart.mockClear();
		mockAuthTest.mockClear();
		mockPostMessage.mockClear();
		mockChatUpdate.mockClear();
		mockFilesUploadV2.mockClear();
	});

	test("multi-chunk response triggers file upload + summary message", async () => {
		mockFilesUploadV2.mockImplementation(() => Promise.resolve({ ok: true }));

		const channel = new SlackChannel(testConfig);
		await channel.connect();

		const longText = "a".repeat(5000);
		await channel.send("slack:C_CHAN:1234.5678", { text: longText });

		expect(mockFilesUploadV2).toHaveBeenCalledTimes(1);
		// Summary message posted (single postMessage, not chunked)
		expect(mockPostMessage).toHaveBeenCalledTimes(1);
	});

	test("upload failure falls back to chunked messages", async () => {
		mockFilesUploadV2.mockImplementation(() => Promise.reject(new Error("not_allowed")));

		const channel = new SlackChannel(testConfig);
		await channel.connect();

		const longText = "a".repeat(5000);
		await channel.send("slack:C_CHAN:1234.5678", { text: longText });

		expect(mockFilesUploadV2).toHaveBeenCalledTimes(1);
		// Falls back to chunked: multiple postMessage calls
		expect(mockPostMessage.mock.calls.length).toBeGreaterThan(1);
	});

	test("single-chunk responses use normal path (no upload)", async () => {
		const channel = new SlackChannel(testConfig);
		await channel.connect();

		await channel.send("slack:C_CHAN:1234.5678", { text: "Short response" });

		expect(mockFilesUploadV2).not.toHaveBeenCalled();
		expect(mockPostMessage).toHaveBeenCalledTimes(1);
	});

	test("uploaded file contains original markdown (not Slack-formatted)", async () => {
		mockFilesUploadV2.mockImplementation(() => Promise.resolve({ ok: true }));

		const channel = new SlackChannel(testConfig);
		await channel.connect();

		const longText = `## Header\n\n${"paragraph ".repeat(500)}`;
		await channel.send("slack:C_CHAN:1234.5678", { text: longText });

		const uploadCalls = mockFilesUploadV2.mock.calls as unknown as Array<[Record<string, unknown>]>;
		const uploadArg = uploadCalls[0][0];
		// The content should be the original markdown, not Slack-formatted
		expect(uploadArg.content).toContain("## Header");
		expect(uploadArg.filename).toBe("response.md");
	});
});

describe("SlackChannel postToChannel", () => {
	beforeEach(() => {
		eventHandlers.clear();
		actionHandlers.clear();
		mockStart.mockClear();
		mockAuthTest.mockClear();
		mockPostMessage.mockClear();
		mockFilesUploadV2.mockClear();
		// Default to success unless a test overrides it. We reset the
		// implementation every beforeEach because prior tests may have swapped
		// it to reject, and mockClear does not reset implementation.
		mockFilesUploadV2.mockImplementation(() => Promise.resolve({ ok: true }));
	});

	test("upload branch receives the full text untruncated even when cap is set", async () => {
		const channel = new SlackChannel(testConfig);
		await channel.connect();

		const body = "x".repeat(6000);
		await channel.postToChannel("C_CHAN", body, "1234.5678", 3500);

		expect(mockFilesUploadV2).toHaveBeenCalledTimes(1);
		const uploadCalls = mockFilesUploadV2.mock.calls as unknown as Array<[Record<string, unknown>]>;
		const content = uploadCalls[0][0].content as string;
		// The cap must NOT apply to the upload path.
		expect(content.length).toBeGreaterThanOrEqual(6000);
		expect(content).not.toContain("…(truncated)");
		expect(content).not.toContain("(truncated; full content was");
	});

	test("chunked fallback applies the cap when upload fails", async () => {
		mockFilesUploadV2.mockImplementation(() => Promise.reject(new Error("not_allowed")));

		const channel = new SlackChannel(testConfig);
		await channel.connect();

		const body = "x".repeat(6000);
		await channel.postToChannel("C_CHAN", body, "1234.5678", 3500);

		// Chunked fallback fired.
		expect(mockPostMessage).toHaveBeenCalled();

		const calls = mockPostMessage.mock.calls as unknown as Array<[Record<string, unknown>]>;
		const concatenatedText = calls.map((c) => c[0].text as string).join("");

		// Total posted text should be ~3500 + a short truncation notice,
		// well under the 6000-char original.
		expect(concatenatedText.length).toBeLessThan(3800);
		expect(concatenatedText).toContain("truncated; full content was 6000 characters");
	});

	test("chunked fallback does not introduce triple-backticks into fence-free text", async () => {
		mockFilesUploadV2.mockImplementation(() => Promise.reject(new Error("not_allowed")));

		const channel = new SlackChannel(testConfig);
		await channel.connect();

		// Regression guard for the removed outer-fence wrapper. Input is
		// plain prose with zero backticks; any triple-backticks in the
		// output would mean this path reintroduced the bug.
		const body = "paragraph ".repeat(600);
		await channel.postToChannel("C_CHAN", body, "1234.5678");

		const calls = mockPostMessage.mock.calls as unknown as Array<[Record<string, unknown>]>;
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			const chunkText = call[0].text as string;
			expect(chunkText).not.toContain("```");
		}
	});

	test("negative cap is treated as no cap (defensive, not a real caller)", async () => {
		mockFilesUploadV2.mockImplementation(() => Promise.reject(new Error("not_allowed")));

		const channel = new SlackChannel(testConfig);
		await channel.connect();

		// A negative cap would make text.slice(0, -1) post "all but the
		// last char" plus a truncation notice, defeating the cap. The code
		// silently ignores negative / non-finite values.
		const body = "x".repeat(4000);
		await channel.postToChannel("C_CHAN", body, "1234.5678", -1);

		const calls = mockPostMessage.mock.calls as unknown as Array<[Record<string, unknown>]>;
		const concatenatedText = calls.map((c) => c[0].text as string).join("");
		// No truncation notice — cap was ignored.
		expect(concatenatedText).not.toContain("truncated; full content was");
		// Full body was delivered (sum of chunks has length close to 4000;
		// Slack formatting + chunk boundaries add a handful of whitespace,
		// so assert lower bound only).
		expect(concatenatedText.length).toBeGreaterThanOrEqual(4000);
	});
});
