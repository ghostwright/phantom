import { App, type LogLevel, SocketModeReceiver } from "@slack/bolt";
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
import { NoopSlackMetrics, type SlackMetricsEmitter } from "./slack-metrics.ts";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

export type SlackChannelConfig = {
	botToken: string;
	appToken: string;
	defaultChannelId?: string;
	ownerUserId?: string;
	transport?: "socket";
	/**
	 * Optional Phase 8a metrics emitter. When omitted, a `NoopSlackMetrics`
	 * is used so the lifecycle hooks fire the same way in test paths that
	 * don't care about Prometheus output. Production wires the shared
	 * `SlackMetrics` instance from `core/server.ts`.
	 */
	metrics?: SlackMetricsEmitter;
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/**
 * Minimal shape of the underlying `@slack/socket-mode` `SocketModeClient`
 * we hook for lifecycle metrics. Bolt's `SocketModeReceiver.client` is
 * publicly typed (`receivers/SocketModeReceiver.d.ts:55`), but we depend
 * only on the EventEmitter interface here so test mocks do not need to
 * carry the full SDK surface.
 */
type SocketModeClientLike = {
	on(event: string, listener: (...args: unknown[]) => void): unknown;
};

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
	private receiver: SocketModeReceiver;
	private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
	private reactionHandler: ReactionHandler | null = null;
	private connectionState: ConnectionState = "disconnected";
	private botUserId: string | null = null;
	private ownerUserId: string | null;
	private phantomName: string;
	private rejectedUsers = new Set<string>();
	private readonly metrics: SlackMetricsEmitter;
	/**
	 * Wall-clock millis when the most recent `connected` event fired. Used to
	 * observe `phantom_slack_socket_connection_seconds` on the next
	 * `disconnected` event. Null when no connection is currently up.
	 */
	private connectedAtMs: number | null = null;

	constructor(config: SlackChannelConfig) {
		if (config.transport && config.transport !== "socket") {
			throw new Error("SlackChannel only supports Socket Mode. Use SlackHttpChannel for HTTP receiver mode.");
		}
		// Construct the receiver explicitly (vs. `socketMode: true` shorthand)
		// so we can hook the underlying `SocketModeClient` lifecycle events for
		// the Phase 8a metrics surface. The receiver type publicly exposes
		// `client: SocketModeClient` (Bolt 4.6 SocketModeReceiver.d.ts:55), so
		// the cast below is type-safe at the package boundary; we narrow to a
		// minimal `SocketModeClientLike` to keep test mocks cheap.
		this.receiver = new SocketModeReceiver({
			appToken: config.appToken,
			logLevel: "ERROR" as LogLevel,
		});
		this.app = new App({
			token: config.botToken,
			receiver: this.receiver,
			logLevel: "ERROR" as LogLevel,
		});
		this.metrics = config.metrics ?? new NoopSlackMetrics();
		this.ownerUserId = config.ownerUserId ?? null;
		this.phantomName = "Phantom";

		// Initialize the gauge to `disconnected` so a Prometheus scrape that
		// lands before `connect()` returns sees a complete time series matrix.
		this.metrics.recordState("disconnected");

		this.attachLifecycleHooks();
		this.attachDispatchTimer();
	}

	/**
	 * Subscribe the metrics emitter to every lifecycle event the underlying
	 * `SocketModeClient` emits. The state enum is verbatim from
	 * `@slack/socket-mode/dist/src/SocketModeClient.js` (the State enum).
	 * `unable_to_socket_mode_start` is NOT an emitted event in the current
	 * SDK; that path surfaces as a thrown `UnrecoverableSocketModeStartError`
	 * from `start()` which we map to the `error` state in `connect()`.
	 */
	private attachLifecycleHooks(): void {
		const client = this.receiver.client as unknown as SocketModeClientLike;

		client.on("connecting", () => {
			this.metrics.recordState("connecting");
		});
		client.on("authenticated", () => {
			this.metrics.recordState("authenticated");
		});
		client.on("connected", () => {
			this.connectedAtMs = Date.now();
			this.metrics.recordState("connected");
		});
		client.on("reconnecting", () => {
			this.metrics.recordReconnect();
			this.metrics.recordState("reconnecting");
			// Reconnect implies the prior connection just dropped; observe its
			// lifetime if we have one in flight.
			this.observeConnectionLifetime();
		});
		client.on("disconnecting", () => {
			this.metrics.recordState("disconnecting");
		});
		client.on("disconnected", () => {
			this.metrics.recordState("disconnected");
			this.observeConnectionLifetime();
		});
	}

	/**
	 * Wraps Bolt's global middleware to time end-to-end event dispatch. The
	 * `next()` await returns when the matching listener (or the absence of
	 * one) has finished, including any async work the user's handler does.
	 * Captures the high-level event type from `body.event.type` when
	 * available; falls back to the envelope `body.type` for slash commands
	 * and interactive payloads, then to `unknown` for shapes Bolt did not
	 * route to a discriminated handler.
	 */
	private attachDispatchTimer(): void {
		this.app.use(async ({ body, next }) => {
			const startMs = Date.now();
			const eventType = extractEventType(body);
			try {
				await next();
			} finally {
				const seconds = (Date.now() - startMs) / 1000;
				this.metrics.observeEventDispatch(eventType, seconds);
			}
		});
	}

	private observeConnectionLifetime(): void {
		if (this.connectedAtMs == null) return;
		const seconds = (Date.now() - this.connectedAtMs) / 1000;
		this.metrics.observeConnectionDuration(seconds);
		this.connectedAtMs = null;
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
			// `app.start()` throws `UnrecoverableSocketModeStartError` for the
			// auth-revoked / invalid-app-token / connections:write-missing
			// failure cases. Mark the gauge so the fleet view reflects the
			// down tenant even though no `disconnected` event ever fired
			// (the SocketModeClient never made it past handshake).
			this.metrics.recordState("error");
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

	async sendDm(userId: string, text: string, blocks?: SlackBlock[]): Promise<string | null> {
		return egressSendDm(this.egressContext(), userId, text, blocks);
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
			if (channelType !== "im") return;

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

/**
 * Pull a stable, low-cardinality string out of Bolt's middleware `body` so
 * the `event_type` label on `phantom_slack_event_dispatch_seconds` does
 * not blow up cardinality. Order:
 *   1. `body.event.type` (the event-API envelope, e.g. `app_mention`,
 *      `message`, `reaction_added`).
 *   2. `body.type` (slash-commands carry `command`, interactivity carries
 *      `block_actions` / `view_submission`).
 *   3. `unknown` fallback so a payload Bolt has not classified still gets
 *      a series.
 */
export function extractEventType(body: unknown): string {
	if (!body || typeof body !== "object") return "unknown";
	const b = body as Record<string, unknown>;
	const event = b.event;
	if (event && typeof event === "object") {
		const ev = event as Record<string, unknown>;
		const t = ev.type;
		if (typeof t === "string" && t.length > 0) return t;
	}
	const top = b.type;
	if (typeof top === "string" && top.length > 0) return top;
	return "unknown";
}
