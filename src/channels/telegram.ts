/**
 * Telegram channel using Telegraf (long polling).
 * Supports inline keyboards, persistent typing, message editing,
 * MarkdownV2 formatting, and command handling.
 */

import { errorMessage } from "../shared/strings.ts";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

type TelegrafBot = {
	launch: () => Promise<void>;
	stop: () => void;
	command: (cmd: string, handler: (ctx: TelegrafContext) => Promise<void>) => void;
	on: (event: string, handler: (ctx: TelegrafContext) => Promise<void>) => void;
	action: (pattern: RegExp, handler: (ctx: TelegrafContext) => Promise<void>) => void;
	telegram: TelegramApi;
};

type TelegramApi = {
	sendMessage: (
		chatId: number | string,
		text: string,
		options?: Record<string, unknown>,
	) => Promise<{ message_id: number }>;
	editMessageText: (
		chatId: number | string,
		messageId: number,
		inlineMessageId: string | undefined,
		text: string,
		options?: Record<string, unknown>,
	) => Promise<unknown>;
	sendChatAction: (chatId: number | string, action: string) => Promise<void>;
};

type TelegrafContext = {
	message?: {
		text?: string;
		from?: { id: number; first_name?: string; username?: string };
		chat: { id: number };
		message_id: number;
	};
	reply: (text: string, options?: Record<string, unknown>) => Promise<{ message_id: number }>;
	telegram: TelegramApi;
	chat?: { id: number };
	from?: { id: number; first_name?: string; username?: string };
	match?: RegExpMatchArray;
	answerCbQuery?: (text?: string) => Promise<void>;
	callbackQuery?: { data?: string; message?: { message_id: number; chat: { id: number } } };
};

export type TelegramChannelConfig = {
	botToken: string;
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export class TelegramChannel implements Channel {
	readonly id = "telegram";
	readonly name = "Telegram";
	readonly capabilities: ChannelCapabilities = {
		threads: false,
		richText: true,
		attachments: true,
		buttons: true,
		inlineKeyboards: true,
		typing: true,
		messageEditing: true,
	};

	private bot: TelegrafBot | null = null;
	private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
	private connectionState: ConnectionState = "disconnected";
	private config: TelegramChannelConfig;
	// Typing keepalive timers per chat
	private typingTimers = new Map<number, ReturnType<typeof setInterval>>();

	constructor(config: TelegramChannelConfig) {
		this.config = config;
	}

	async connect(): Promise<void> {
		if (this.connectionState === "connected") return;
		this.connectionState = "connecting";

		try {
			const { Telegraf } = await import("telegraf");
			this.bot = new Telegraf(this.config.botToken) as unknown as TelegrafBot;

			this.registerHandlers();
			await this.bot.launch();
			this.connectionState = "connected";
			console.log("[telegram] Bot connected via long polling");
		} catch (err: unknown) {
			this.connectionState = "error";
			const msg = errorMessage(err);
			console.error(`[telegram] Failed to connect: ${msg}`);
			throw err;
		}
	}

	async disconnect(): Promise<void> {
		if (this.connectionState === "disconnected") return;

		// Clear all typing timers
		for (const timer of this.typingTimers.values()) {
			clearInterval(timer);
		}
		this.typingTimers.clear();

		try {
			this.bot?.stop();
		} catch (err: unknown) {
			const msg = errorMessage(err);
			console.warn(`[telegram] Error during disconnect: ${msg}`);
		}

		this.connectionState = "disconnected";
		console.log("[telegram] Disconnected");
	}

	async send(conversationId: string, message: OutboundMessage): Promise<SentMessage> {
		if (!this.bot) throw new Error("Telegram bot not connected");

		const chatId = parseTelegramConversationId(conversationId);
		const text = escapeMarkdownV2(message.text);

		const result = await this.bot.telegram.sendMessage(chatId, text, {
			parse_mode: "MarkdownV2",
		});

		return {
			id: String(result.message_id),
			channelId: this.id,
			conversationId,
			timestamp: new Date(),
		};
	}

	onMessage(handler: (message: InboundMessage) => Promise<void>): void {
		this.messageHandler = handler;
	}

	isConnected(): boolean {
		return this.connectionState === "connected";
	}

	getConnectionState(): ConnectionState {
		return this.connectionState;
	}

	/** Start persistent typing indicator for a chat */
	startTyping(chatId: number): void {
		this.stopTyping(chatId);
		// Telegram typing indicator expires after 5s, so re-fire every 4s
		void this.bot?.telegram.sendChatAction(chatId, "typing").catch(() => {});
		const timer = setInterval(() => {
			void this.bot?.telegram.sendChatAction(chatId, "typing").catch(() => {});
		}, 4000);
		this.typingTimers.set(chatId, timer);
	}

	/** Stop persistent typing indicator */
	stopTyping(chatId: number): void {
		const timer = this.typingTimers.get(chatId);
		if (timer) {
			clearInterval(timer);
			this.typingTimers.delete(chatId);
		}
	}

	/** Send a message with inline keyboard buttons */
	async sendWithKeyboard(
		chatId: number,
		text: string,
		buttons: Array<Array<{ text: string; callback_data: string }>>,
	): Promise<number> {
		if (!this.bot) throw new Error("Telegram bot not connected");

		const result = await this.bot.telegram.sendMessage(chatId, escapeMarkdownV2(text), {
			parse_mode: "MarkdownV2",
			reply_markup: { inline_keyboard: buttons },
		});
		return result.message_id;
	}

	/** Edit an existing message */
	async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
		if (!this.bot) return;
		try {
			await this.bot.telegram.editMessageText(chatId, messageId, undefined, escapeMarkdownV2(text), {
				parse_mode: "MarkdownV2",
			});
		} catch (err: unknown) {
			const msg = errorMessage(err);
			// "message is not modified" is expected when text hasn't changed
			if (!msg.includes("message is not modified")) {
				console.warn(`[telegram] Failed to edit message: ${msg}`);
			}
		}
	}

	private registerHandlers(): void {
		if (!this.bot) return;

		this.bot.command("start", async (ctx) => {
			await ctx.reply("Hello! I'm Phantom, your AI co-worker. Send me a message to get started.");
		});

		this.bot.command("status", async (ctx) => {
			await ctx.reply("Phantom is running and ready to help.");
		});

		this.bot.command("help", async (ctx) => {
			await ctx.reply(
				"Send me any message and I'll help you out.\n\nCommands:\n/start - Introduction\n/status - Check status\n/help - Show this message",
			);
		});

		this.bot.on("text", async (ctx) => {
			if (!this.messageHandler || !ctx.message?.text) return;

			const text = ctx.message.text;
			// Skip commands (they're handled above)
			if (text.startsWith("/")) return;

			const chatId = ctx.message.chat.id;
			const from = ctx.message.from;
			const conversationId = `telegram:${chatId}`;

			const inbound: InboundMessage = {
				id: String(ctx.message.message_id),
				channelId: this.id,
				conversationId,
				senderId: String(from?.id ?? "unknown"),
				senderName: from?.first_name ?? from?.username,
				text,
				timestamp: new Date(),
				metadata: {
					telegramChatId: chatId,
					telegramMessageId: ctx.message.message_id,
				},
			};

			try {
				await this.messageHandler(inbound);
			} catch (err: unknown) {
				const msg = errorMessage(err);
				console.error(`[telegram] Error handling message: ${msg}`);
			}
		});

		// Handle inline keyboard button presses
		this.bot.action(/^phantom:(.+)$/, async (ctx) => {
			if (ctx.answerCbQuery) {
				await ctx.answerCbQuery();
			}

			const data = ctx.match?.[1];
			if (!data || !this.messageHandler) return;

			const chatId = ctx.callbackQuery?.message?.chat.id;
			if (!chatId) return;

			const from = ctx.from;
			const conversationId = `telegram:${chatId}`;

			const inbound: InboundMessage = {
				id: `cb_${Date.now()}`,
				channelId: this.id,
				conversationId,
				senderId: String(from?.id ?? "unknown"),
				senderName: from?.first_name ?? from?.username,
				text: data,
				timestamp: new Date(),
				metadata: {
					telegramChatId: chatId,
					source: "callback_query",
					callbackData: data,
				},
			};

			try {
				await this.messageHandler(inbound);
			} catch (err: unknown) {
				const msg = errorMessage(err);
				console.error(`[telegram] Error handling callback: ${msg}`);
			}
		});
	}
}

function parseTelegramConversationId(conversationId: string): number {
	// Format: "telegram:{chat_id}"
	const chatId = conversationId.split(":")[1];
	return Number(chatId);
}

/**
 * Escape special characters for Telegram MarkdownV2.
 * Characters that need escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
function escapeMarkdownV2(text: string): string {
	// Preserve code blocks
	const codeBlocks: string[] = [];
	let result = text.replace(/```[\s\S]*?```/g, (match) => {
		codeBlocks.push(match);
		return `\x00CB${codeBlocks.length - 1}\x00`;
	});

	// Preserve inline code
	const inlineCodes: string[] = [];
	result = result.replace(/`[^`]+`/g, (match) => {
		inlineCodes.push(match);
		return `\x00IC${inlineCodes.length - 1}\x00`;
	});

	// Escape special characters outside of code
	result = result.replace(/([_*\[\]()~>#+\-=|{}.!\\])/g, "\\$1");

	// Restore inline code and code blocks
	for (let i = 0; i < inlineCodes.length; i++) {
		result = result.replace(`\x00IC${i}\x00`, inlineCodes[i]);
	}
	for (let i = 0; i < codeBlocks.length; i++) {
		result = result.replace(`\x00CB${i}\x00`, codeBlocks[i]);
	}

	return result;
}
