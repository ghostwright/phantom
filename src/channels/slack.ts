import { App, type LogLevel } from "@slack/bolt";
import type { SlackBlock } from "./feedback.ts";
import { registerSlackActions } from "./slack-actions.ts";
import {
	type EgressContext,
	egressAddReaction,
	egressPostThinking,
	egressPostToChannel,
	egressRemoveReaction,
	egressSend,
	egressSendDm,
	egressUpdateMessage,
	egressUpdateWithFeedback,
} from "./slack-egress.ts";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

export type SlackChannelConfig = {
	botToken: string;
	appToken: string;
	defaultChannelId?: string;
	ownerUserId?: string;
	transport?: "socket";
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

type ReactionHandler = (event: {
	reaction: string;
	userId: string;
	messageTs: string;
	channel: string;
	isPositive: boolean;
}) => void;

export class SlackChannel implements Channel {
	readonly id = "slack";
	readonly name = "Slack";
	readonly capabilities: ChannelCapabilities = {
		threads: true,
		richText: true,
		attachments: true,
		buttons: true,
		reactions: true,
		progressUpdates: true,
	};

	private app: App;
	private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
	private reactionHandler: ReactionHandler | null = null;
	private connectionState: ConnectionState = "disconnected";
	private botUserId: string | null = null;
	private ownerUserId: string | null;
	private phantomName: string;
	private rejectedUsers = new Set<string>();
	private participatedThreads = new Set<string>();

	constructor(config: SlackChannelConfig) {
		if (config.transport && config.transport !== "socket") {
			throw new Error("SlackChannel only supports Socket Mode. Use SlackHttpChannel for HTTP receiver mode.");
		}
		this.app = new App({
			token: config.botToken,
			socketMode: true,
			appToken: config.appToken,
			logLevel: "ERROR" as LogLevel,
		});
		this.ownerUserId = config.ownerUserId ?? null;
		this.phantomName = "Phantom";
	}

	setPhantomName(name: string): void {
		this.phantomName = name;
	}

	getOwnerUserId(): string | null {
		return this.ownerUserId;
	}

	/** Expose the Slack client for profile API calls */
	getClient(): App["client"] {
		return this.app.client;
	}

	private isOwner(userId: string): boolean {
		if (!this.ownerUserId) return true;
		return userId === this.ownerUserId;
	}

	private async rejectNonOwner(userId: string): Promise<void> {
		// Only send the rejection once per user to avoid spam
		if (this.rejectedUsers.has(userId)) return;
		this.rejectedUsers.add(userId);

		try {
			const openResult = await this.app.client.conversations.open({ users: userId });
			const dmChannelId = openResult.channel?.id;
			if (dmChannelId) {
				await this.app.client.chat.postMessage({
					channel: dmChannelId,
					text: `Hey! I'm ${this.phantomName}, a personal AI co-worker. I can only respond to my owner. If you need your own, check out github.com/ghostwright/phantom.`,
				});
			}
		} catch {
			// Best effort - don't fail if we can't DM them
		}
	}

	async connect(): Promise<void> {
		if (this.connectionState === "connected") return;
		this.connectionState = "connecting";

		this.registerEventHandlers();
		registerSlackActions(this.app);

		try {
			await this.app.start();
			this.connectionState = "connected";

			try {
				const authResult = await this.app.client.auth.test();
				this.botUserId = authResult.user_id ?? null;
				console.log(`[slack] Connected as <@${this.botUserId}>`);
			} catch {
				console.warn("[slack] Could not resolve bot user ID. Self-message filtering may not work.");
			}

			console.log("[slack] Socket Mode connected");
		} catch (err: unknown) {
			this.connectionState = "error";
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[slack] Failed to connect: ${msg}`);
			throw err;
		}
	}

	async disconnect(): Promise<void> {
		if (this.connectionState === "disconnected") return;

		try {
			await this.app.stop();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[slack] Error during disconnect: ${msg}`);
		}

		this.connectionState = "disconnected";
		console.log("[slack] Disconnected");
	}

	private egressContext(): EgressContext {
		return { client: this.app.client, channelId: this.id, logTag: "slack" };
	}

	async send(conversationId: string, message: OutboundMessage): Promise<SentMessage> {
		return egressSend(this.egressContext(), conversationId, message);
	}

	onMessage(handler: (message: InboundMessage) => Promise<void>): void {
		this.messageHandler = handler;
	}

	onReaction(handler: ReactionHandler): void {
		this.reactionHandler = handler;
	}

	isConnected(): boolean {
		return this.connectionState === "connected";
	}

	getConnectionState(): ConnectionState {
		return this.connectionState;
	}

	async postToChannel(channelId: string, text: string): Promise<string | null> {
		return egressPostToChannel(this.egressContext(), channelId, text);
	}

	async sendDm(userId: string, text: string): Promise<string | null> {
		return egressSendDm(this.egressContext(), userId, text);
	}

	async postThinking(channel: string, threadTs: string): Promise<string | null> {
		return egressPostThinking(this.egressContext(), channel, threadTs);
	}

	async updateMessage(channel: string, ts: string, text: string, blocks?: SlackBlock[]): Promise<void> {
		return egressUpdateMessage(this.egressContext(), channel, ts, text, blocks);
	}

	/** Update a message with text + feedback buttons appended */
	async updateWithFeedback(channel: string, ts: string, text: string): Promise<void> {
		return egressUpdateWithFeedback(this.egressContext(), channel, ts, text);
	}

	async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
		return egressAddReaction(this.egressContext(), channel, messageTs, emoji);
	}

	async removeReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
		return egressRemoveReaction(this.egressContext(), channel, messageTs, emoji);
	}

	trackThreadParticipation(channelId: string, threadTs: string): void {
		this.participatedThreads.add(`${channelId}:${threadTs}`);
	}

	private registerEventHandlers(): void {
		this.app.event("app_mention", async ({ event, client: _client }) => {
			if (!this.messageHandler) return;

			const senderId = event.user ?? "unknown";
			if (!this.isOwner(senderId)) {
				console.log(`[slack] Ignoring app_mention from non-owner: ${senderId}`);
				await this.rejectNonOwner(senderId);
				return;
			}

			const cleanText = this.stripBotMention(event.text);
			if (!cleanText.trim()) return;

			const threadTs = event.thread_ts ?? event.ts;
			const conversationId = buildConversationId(event.channel, threadTs);

			const inbound: InboundMessage = {
				id: event.ts,
				channelId: this.id,
				conversationId,
				threadId: threadTs,
				senderId,
				text: cleanText.trim(),
				timestamp: new Date(Number.parseFloat(event.ts) * 1000),
				metadata: {
					slackChannel: event.channel,
					slackThreadTs: threadTs,
					slackMessageTs: event.ts,
					source: "app_mention",
				},
			};

			try {
				await this.messageHandler(inbound);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[slack] Error handling app_mention: ${msg}`);
			}
		});

		this.app.event("message", async ({ event }) => {
			if (!this.messageHandler) return;

			const msg = event as unknown as Record<string, unknown>;
			if (msg.subtype) return;
			if (msg.bot_id) return;

			const userId = msg.user as string | undefined;
			if (this.botUserId && userId === this.botUserId) return;

			const channelType = msg.channel_type as string | undefined;
			if (channelType !== "im") {
				// In channels, only respond to thread replies in threads we've participated in
				const incomingThreadTs = msg.thread_ts as string | undefined;
				if (!incomingThreadTs) return;
				const threadKey = `${msg.channel as string}:${incomingThreadTs}`;
				if (!this.participatedThreads.has(threadKey)) return;
			}

			if (userId && !this.isOwner(userId)) {
				console.log(`[slack] Ignoring DM from non-owner: ${userId}`);
				await this.rejectNonOwner(userId);
				return;
			}

			const text = (msg.text as string) ?? "";
			if (!text.trim()) return;

			const channel = msg.channel as string;
			const ts = msg.ts as string;
			const threadTs = (msg.thread_ts as string) ?? ts;
			// DMs use the same thread-scoped session boundary as channels.
			// Each thread (or top-level message) gets its own session.
			// Cross-session continuity comes from Qdrant memory, not session resume.
			const conversationId = buildConversationId(channel, threadTs);

			const inbound: InboundMessage = {
				id: ts,
				channelId: this.id,
				conversationId,
				threadId: threadTs,
				senderId: userId ?? "unknown",
				text: text.trim(),
				timestamp: new Date(Number.parseFloat(ts) * 1000),
				metadata: {
					slackChannel: channel,
					slackThreadTs: threadTs,
					slackMessageTs: ts,
					source: "dm",
				},
			};

			try {
				await this.messageHandler(inbound);
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				console.error(`[slack] Error handling DM: ${errMsg}`);
			}
		});

		this.app.event("reaction_added", async ({ event }) => {
			const reaction = event.reaction;
			const isPositive =
				reaction === "+1" || reaction === "thumbsup" || reaction === "heart" || reaction === "white_check_mark";
			const isNegative = reaction === "-1" || reaction === "thumbsdown" || reaction === "x";

			if (!isPositive && !isNegative) return;

			console.log(`[slack] Reaction ${isPositive ? "positive" : "negative"}: :${reaction}: from ${event.user}`);

			if (this.reactionHandler) {
				this.reactionHandler({
					reaction,
					userId: event.user,
					messageTs: event.item.ts,
					channel: event.item.channel,
					isPositive,
				});
			}
		});
	}

	private stripBotMention(text: string): string {
		if (this.botUserId) {
			return text.replace(new RegExp(`<@${this.botUserId}>\\s*`, "g"), "");
		}
		return text.replace(/^<@[A-Z0-9]+>\s*/, "");
	}
}

function buildConversationId(channel: string, threadTs: string): string {
	return `slack:${channel}:${threadTs}`;
}
