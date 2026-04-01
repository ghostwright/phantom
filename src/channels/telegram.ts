/**
 * Telegram channel using Telegraf (long polling).
 * Supports inline keyboards, persistent typing, message editing,
 * HTML formatting, and command handling.
 */

import { markdownToTelegramHtml, splitMessage, stripHtml } from "./telegram-utils.ts";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

type TelegrafBot = {
	launch: (onLaunch?: () => void) => Promise<void>;
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
	/** Whitelist of Telegram user IDs allowed to interact with the bot. Empty = allow all. */
	allowedUserIds?: number[];
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

			// launch() blocks forever (polling loop). Use the onLaunch callback which fires
			// after getMe() succeeds but before polling starts, so we can resolve connect()
			// without waiting for the loop to end.
			const bot = this.bot;
			await new Promise<void>((resolve, reject) => {
				bot.launch(resolve).catch(reject);
			});

			this.connectionState = "connected";
			console.log("[telegram] Bot connected via long polling");
		} catch (err: unknown) {
			this.connectionState = "error";
			const msg = err instanceof Error ? err.message : String(err);
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
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[telegram] Error during disconnect: ${msg}`);
		}

		this.connectionState = "disconnected";
		console.log("[telegram] Disconnected");
	}

	async send(conversationId: string, message: OutboundMessage): Promise<SentMessage> {
		if (!this.bot) throw new Error("Telegram bot not connected");

		const chatId = parseTelegramConversationId(conversationId);
		const text = markdownToTelegramHtml(message.text);
		const chunks = splitMessage(text);

		let lastMessageId = 0;
		for (const chunk of chunks) {
			try {
				const result = await this.bot.telegram.sendMessage(chatId, chunk, {
					parse_mode: "HTML",
				});
				lastMessageId = result.message_id;
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				console.error(`[telegram] Failed to send message chunk: ${errMsg}`);
				// Retry as plain text when HTML is malformed
				try {
					const result = await this.bot.telegram.sendMessage(chatId, stripHtml(chunk));
					lastMessageId = result.message_id;
				} catch (fallbackErr: unknown) {
					const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
					console.error(`[telegram] Fallback send also failed: ${fallbackMsg}`);
					throw fallbackErr;
				}
			}
		}

		return {
			id: String(lastMessageId),
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

		const result = await this.bot.telegram.sendMessage(chatId, markdownToTelegramHtml(text), {
			parse_mode: "HTML",
			reply_markup: { inline_keyboard: buttons },
		});
		return result.message_id;
	}

	/** Edit an existing message */
	async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
		if (!this.bot) return;
		try {
			await this.bot.telegram.editMessageText(chatId, messageId, undefined, markdownToTelegramHtml(text), {
				parse_mode: "HTML",
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			// "message is not modified" is expected when text hasn't changed
			if (!msg.includes("message is not modified")) {
				console.warn(`[telegram] Failed to edit message: ${msg}`);
			}
		}
	}

	private isAllowed(userId: number | undefined): boolean {
		if (!userId) return false;
		const { allowedUserIds } = this.config;
		if (!allowedUserIds || allowedUserIds.length === 0) return true;
		return allowedUserIds.includes(userId);
	}

	private registerHandlers(): void {
		if (!this.bot) return;

		this.bot.command("start", async (ctx) => {
			const userId = ctx.from?.id;
			if (!this.isAllowed(userId)) {
				console.warn(`[telegram] Unauthorized /start from user ${userId}`);
				try {
					await ctx.reply("Unauthorized.");
				} catch {
					/* ignore send errors */
				}
				return;
			}
			try {
				await ctx.reply("Hello! I'm Phantom, your AI co-worker. Send me a message to get started.");
			} catch {
				/* ignore send errors */
			}
		});

		this.bot.command("status", async (ctx) => {
			const userId = ctx.from?.id;
			if (!this.isAllowed(userId)) {
				console.warn(`[telegram] Unauthorized /status from user ${userId}`);
				try {
					await ctx.reply("Unauthorized.");
				} catch {
					/* ignore send errors */
				}
				return;
			}
			try {
				await ctx.reply("Phantom is running and ready to help.");
			} catch {
				/* ignore send errors */
			}
		});

		this.bot.command("help", async (ctx) => {
			const userId = ctx.from?.id;
			if (!this.isAllowed(userId)) {
				console.warn(`[telegram] Unauthorized /help from user ${userId}`);
				try {
					await ctx.reply("Unauthorized.");
				} catch {
					/* ignore send errors */
				}
				return;
			}
			try {
				await ctx.reply(
					"Send me any message and I'll help you out.\n\nCommands:\n/start - Introduction\n/status - Check status\n/help - Show this message",
				);
			} catch {
				/* ignore send errors */
			}
		});

		this.bot.on("text", async (ctx) => {
			if (!this.messageHandler || !ctx.message?.text) return;

			const text = ctx.message.text;
			// Skip commands (they're handled above)
			if (text.startsWith("/")) return;

			const chatId = ctx.message.chat.id;
			const from = ctx.message.from;

			if (!this.isAllowed(from?.id)) {
				console.warn(`[telegram] Unauthorized message from user ${from?.id} (${from?.username ?? "unknown"})`);
				await ctx.reply("Unauthorized.");
				return;
			}

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
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[telegram] Error handling message: ${msg}`);
			}
		});

		// Handle inline keyboard button presses
		this.bot.action(/^phantom:(.+)$/, async (ctx) => {
			if (ctx.answerCbQuery) {
				await ctx.answerCbQuery();
			}

			const from = ctx.from;
			if (!this.isAllowed(from?.id)) {
				console.warn(`[telegram] Unauthorized callback from user ${from?.id} (${from?.username ?? "unknown"})`);
				return;
			}

			const data = ctx.match?.[1];
			if (!data || !this.messageHandler) return;

			const chatId = ctx.callbackQuery?.message?.chat.id;
			if (!chatId) return;
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
				const msg = err instanceof Error ? err.message : String(err);
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
