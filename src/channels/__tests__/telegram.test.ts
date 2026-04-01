import { beforeEach, describe, expect, mock, test } from "bun:test";
import { TELEGRAM_MAX_LENGTH, markdownToTelegramHtml, splitMessage, stripHtml } from "../telegram-utils.ts";
import { TelegramChannel, type TelegramChannelConfig } from "../telegram.ts";

// Mock Telegraf
// launch() must call its onLaunch callback to unblock connect(), simulating the
// real Telegraf behavior where the callback fires after getMe() succeeds.
const mockLaunch = mock((onLaunch?: () => void) => {
	onLaunch?.();
	return Promise.resolve();
});
const mockStop = mock(() => {});
const mockSendMessage = mock(async (_chatId: number | string, _text: string, _opts?: Record<string, unknown>) => ({
	message_id: 42,
}));
const mockEditMessageText = mock(
	async (
		_chatId: number | string,
		_msgId: number,
		_inlineMsgId: string | undefined,
		_text: string,
		_opts?: Record<string, unknown>,
	) => ({}),
);
const mockSendChatAction = mock(async (_chatId: number | string, _action: string) => {});
const mockReply = mock(async (_text: string, _opts?: Record<string, unknown>) => ({ message_id: 99 }));

type HandlerFn = (ctx: Record<string, unknown>) => Promise<void>;
const commandHandlers = new Map<string, HandlerFn>();
const eventHandlers = new Map<string, HandlerFn>();
const actionPatterns: Array<{ pattern: RegExp; handler: HandlerFn }> = [];

const MockTelegraf = mock((_token: string) => ({
	launch: mockLaunch,
	stop: mockStop,
	command: (cmd: string, handler: HandlerFn) => {
		commandHandlers.set(cmd, handler);
	},
	on: (event: string, handler: HandlerFn) => {
		eventHandlers.set(event, handler);
	},
	action: (pattern: RegExp, handler: HandlerFn) => {
		actionPatterns.push({ pattern, handler });
	},
	telegram: {
		sendMessage: mockSendMessage,
		editMessageText: mockEditMessageText,
		sendChatAction: mockSendChatAction,
	},
}));

mock.module("telegraf", () => ({
	Telegraf: MockTelegraf,
}));

const testConfig: TelegramChannelConfig = {
	botToken: "123456:ABC-DEF",
};

const restrictedConfig: TelegramChannelConfig = {
	botToken: "123456:ABC-DEF",
	allowedUserIds: [111, 222],
};

describe("TelegramChannel", () => {
	beforeEach(() => {
		commandHandlers.clear();
		eventHandlers.clear();
		actionPatterns.length = 0;
		mockLaunch.mockClear();
		mockStop.mockClear();
		mockSendMessage.mockClear();
		mockEditMessageText.mockClear();
		mockSendChatAction.mockClear();
		mockReply.mockClear();
	});

	test("has correct id and capabilities", () => {
		const channel = new TelegramChannel(testConfig);
		expect(channel.id).toBe("telegram");
		expect(channel.name).toBe("Telegram");
		expect(channel.capabilities.inlineKeyboards).toBe(true);
		expect(channel.capabilities.typing).toBe(true);
		expect(channel.capabilities.messageEditing).toBe(true);
	});

	test("starts disconnected", () => {
		const channel = new TelegramChannel(testConfig);
		expect(channel.isConnected()).toBe(false);
	});

	test("connect transitions to connected", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		expect(channel.isConnected()).toBe(true);
		expect(mockLaunch).toHaveBeenCalledTimes(1);
	});

	test("disconnect transitions to disconnected", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		await channel.disconnect();
		expect(channel.isConnected()).toBe(false);
	});

	test("registers command handlers on connect", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		expect(commandHandlers.has("start")).toBe(true);
		expect(commandHandlers.has("status")).toBe(true);
		expect(commandHandlers.has("help")).toBe(true);
	});

	test("registers text handler on connect", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();
		expect(eventHandlers.has("text")).toBe(true);
	});

	test("routes text messages to handler", async () => {
		const channel = new TelegramChannel(testConfig);
		let receivedText = "";

		channel.onMessage(async (msg) => {
			receivedText = msg.text;
		});

		await channel.connect();

		const textHandler = eventHandlers.get("text");
		expect(textHandler).toBeDefined();
		if (textHandler) {
			await textHandler({
				message: {
					text: "Hello Phantom",
					from: { id: 12345, first_name: "Test" },
					chat: { id: 67890 },
					message_id: 1,
				},
				reply: mockReply,
			});
		}

		expect(receivedText).toBe("Hello Phantom");
	});

	test("ignores slash commands in text handler", async () => {
		const channel = new TelegramChannel(testConfig);
		let handlerCalled = false;

		channel.onMessage(async () => {
			handlerCalled = true;
		});

		await channel.connect();

		const textHandler = eventHandlers.get("text");
		if (textHandler) {
			await textHandler({
				message: {
					text: "/start",
					from: { id: 12345 },
					chat: { id: 67890 },
					message_id: 1,
				},
				reply: mockReply,
			});
		}

		expect(handlerCalled).toBe(false);
	});

	test("sends message via send method using HTML mode", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();

		const result = await channel.send("telegram:67890", { text: "Hello" });
		expect(result.channelId).toBe("telegram");
		expect(result.id).toBe("42");
		expect(mockSendMessage).toHaveBeenCalledTimes(1);
		// Verify HTML parse mode is used
		const [, , opts] = mockSendMessage.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
		expect(opts?.parse_mode).toBe("HTML");
	});

	test("splits long messages into multiple sends", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();

		// Create a message longer than TELEGRAM_MAX_LENGTH
		const longText = "a".repeat(TELEGRAM_MAX_LENGTH + 100);
		await channel.send("telegram:67890", { text: longText });

		expect(mockSendMessage).toHaveBeenCalledTimes(2);
	});

	test("falls back to plain text when HTML send fails", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();

		// First call fails (malformed HTML), second call (plain text) succeeds
		mockSendMessage
			.mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
			.mockResolvedValueOnce({ message_id: 55 });

		const result = await channel.send("telegram:67890", { text: "Hello <world>" });
		expect(mockSendMessage).toHaveBeenCalledTimes(2);
		expect(result.id).toBe("55");
		// Second call has no parse_mode (plain text)
		const [, , plainOpts] = mockSendMessage.mock.calls[1] as [unknown, unknown, Record<string, unknown> | undefined];
		expect(plainOpts?.parse_mode).toBeUndefined();
	});

	test("startTyping sends chat action and sets interval", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();

		channel.startTyping(67890);
		expect(mockSendChatAction).toHaveBeenCalledWith(67890, "typing");

		channel.stopTyping(67890);
	});

	test("stopTyping clears the typing interval", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();

		channel.startTyping(67890);
		channel.stopTyping(67890);

		// The interval fires every 4s. Wait 4.5s to confirm it was cleared.
		mockSendChatAction.mockClear();
		await new Promise((r) => setTimeout(r, 4500));
		expect(mockSendChatAction).not.toHaveBeenCalled();
	}, 10000);

	test("editMessage calls telegram API using HTML mode", async () => {
		const channel = new TelegramChannel(testConfig);
		await channel.connect();

		await channel.editMessage(67890, 42, "Updated text");
		expect(mockEditMessageText).toHaveBeenCalledTimes(1);
		const [, , , , editOpts] = mockEditMessageText.mock.calls[0] as [
			unknown,
			unknown,
			unknown,
			unknown,
			Record<string, unknown>,
		];
		expect(editOpts?.parse_mode).toBe("HTML");
	});

	describe("access control (allowedUserIds)", () => {
		test("allows all users when no allowedUserIds configured", async () => {
			const channel = new TelegramChannel(testConfig);
			let handlerCalled = false;
			channel.onMessage(async () => {
				handlerCalled = true;
			});
			await channel.connect();

			const textHandler = eventHandlers.get("text");
			if (textHandler) {
				await textHandler({
					message: { text: "hi", from: { id: 99999 }, chat: { id: 1 }, message_id: 1 },
					reply: mockReply,
				});
			}
			expect(handlerCalled).toBe(true);
		});

		test("allows whitelisted user", async () => {
			const channel = new TelegramChannel(restrictedConfig);
			let handlerCalled = false;
			channel.onMessage(async () => {
				handlerCalled = true;
			});
			await channel.connect();

			const textHandler = eventHandlers.get("text");
			if (textHandler) {
				await textHandler({
					message: { text: "hi", from: { id: 111 }, chat: { id: 1 }, message_id: 1 },
					reply: mockReply,
				});
			}
			expect(handlerCalled).toBe(true);
		});

		test("blocks non-whitelisted user and replies Unauthorized", async () => {
			const channel = new TelegramChannel(restrictedConfig);
			let handlerCalled = false;
			channel.onMessage(async () => {
				handlerCalled = true;
			});
			await channel.connect();

			const textHandler = eventHandlers.get("text");
			if (textHandler) {
				await textHandler({
					message: { text: "hi", from: { id: 99999 }, chat: { id: 1 }, message_id: 1 },
					reply: mockReply,
				});
			}
			expect(handlerCalled).toBe(false);
			expect(mockReply).toHaveBeenCalledWith("Unauthorized.");
		});

		test("blocks unauthorized user from /start command", async () => {
			const channel = new TelegramChannel(restrictedConfig);
			await channel.connect();

			const startHandler = commandHandlers.get("start");
			if (startHandler) {
				await startHandler({ from: { id: 99999 }, reply: mockReply });
			}
			expect(mockReply).toHaveBeenCalledWith("Unauthorized.");
		});

		test("blocks unauthorized user from /status command", async () => {
			const channel = new TelegramChannel(restrictedConfig);
			await channel.connect();

			const statusHandler = commandHandlers.get("status");
			if (statusHandler) {
				await statusHandler({ from: { id: 99999 }, reply: mockReply });
			}
			expect(mockReply).toHaveBeenCalledWith("Unauthorized.");
		});

		test("blocks unauthorized user from /help command", async () => {
			const channel = new TelegramChannel(restrictedConfig);
			await channel.connect();

			const helpHandler = commandHandlers.get("help");
			if (helpHandler) {
				await helpHandler({ from: { id: 99999 }, reply: mockReply });
			}
			expect(mockReply).toHaveBeenCalledWith("Unauthorized.");
		});

		test("authorized user gets /start response", async () => {
			const channel = new TelegramChannel(restrictedConfig);
			await channel.connect();

			const startHandler = commandHandlers.get("start");
			if (startHandler) {
				await startHandler({ from: { id: 111 }, reply: mockReply });
			}
			expect(mockReply).toHaveBeenCalledTimes(1);
			const [replyText] = mockReply.mock.calls[0] as [string];
			expect(replyText).toContain("Phantom");
		});
	});
});

describe("splitMessage", () => {
	test("returns single chunk for short messages", () => {
		const chunks = splitMessage("Hello world");
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toBe("Hello world");
	});

	test("splits at newline near limit", () => {
		const line = "a".repeat(2000);
		const text = `${line}\n${line}\n${line}`;
		const chunks = splitMessage(text);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_LENGTH);
		}
	});

	test("hard-splits when no newline available", () => {
		const text = "a".repeat(TELEGRAM_MAX_LENGTH + 500);
		const chunks = splitMessage(text);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_LENGTH);
		}
	});

	test("preserves all content across chunks", () => {
		const text = Array.from({ length: 10 }, (_, i) => `Line ${i}: ${"x".repeat(500)}`).join("\n");
		const chunks = splitMessage(text);
		const rejoined = chunks.join("\n");
		// All original content should be present (trimStart may remove leading newlines between chunks)
		expect(rejoined.replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
	});
});

describe("stripHtml", () => {
	test("removes HTML tags", () => {
		expect(stripHtml("<b>bold</b>")).toBe("bold");
	});

	test("decodes HTML entities", () => {
		expect(stripHtml("a &lt; b &gt; c &amp; d")).toBe("a < b > c & d");
	});

	test("handles nested tags", () => {
		expect(stripHtml("<pre><code>hello</code></pre>")).toBe("hello");
	});

	test("returns plain text unchanged", () => {
		expect(stripHtml("plain text")).toBe("plain text");
	});
});

describe("markdownToTelegramHtml", () => {
	test("converts bold markdown to HTML", () => {
		expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>");
	});

	test("converts italic markdown to HTML", () => {
		expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>");
	});

	test("converts strikethrough to HTML", () => {
		expect(markdownToTelegramHtml("~~strike~~")).toBe("<s>strike</s>");
	});

	test("converts headings to bold", () => {
		expect(markdownToTelegramHtml("# Heading")).toBe("<b>Heading</b>");
	});

	test("converts fenced code blocks to pre/code", () => {
		const result = markdownToTelegramHtml("```\nhello\n```");
		expect(result).toContain("<pre><code>");
		expect(result).toContain("hello");
	});

	test("converts inline code to code tags", () => {
		expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
	});

	test("escapes HTML special chars in plain text", () => {
		expect(markdownToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
	});

	test("does not escape HTML inside code blocks", () => {
		const result = markdownToTelegramHtml("```\na < b\n```");
		expect(result).toContain("&lt;");
	});

	test("converts list items to bullet points", () => {
		expect(markdownToTelegramHtml("- item")).toBe("• item");
	});
});
