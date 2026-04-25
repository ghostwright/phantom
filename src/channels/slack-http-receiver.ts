// Phase 5b: HTTP receiver mode for Phantom Cloud tenants. Slack events are
// captured by a shared central gateway (phantom-slack-events), verified
// against Slack's signing secret there, then forwarded over HTTPS to the
// per-tenant Phantom on this VM. Self-hosters keep the Socket Mode flow at
// `slack.ts`; SLACK_TRANSPORT=http opts a tenant into this class.
//
// Three security layers operate at this boundary:
//   1. The Caddy edge in front of the tenant validates the gateway's HMAC
//      and strips inbound X-Phantom-* headers (defense in depth at the
//      reverse proxy).
//   2. This class re-verifies the gateway's HMAC on every request via the
//      `slack-gateway-verifier` helper before Bolt sees the body.
//   3. After HMAC succeeds, the parsed body's team_id MUST match the
//      tenant's installer team_id. The gateway has already verified team_id
//      maps to this tenant, but a misrouted forward must not be processed.
//
// We reuse Bolt's App + ExpressReceiver so the existing slack-actions.ts
// registrations (`app.action(...)`) compose unchanged. ExpressReceiver is
// constructed with `signatureVerification: false` because we verified the
// gateway's HMAC ourselves.

import { randomUUID } from "node:crypto";
import { App, ExpressReceiver, type LogLevel } from "@slack/bolt";
import type { Request, RequestHandler, Response } from "express";
import type { SlackBlock } from "./feedback.ts";
import { buildFeedbackBlocks } from "./feedback.ts";
import { registerSlackActions } from "./slack-actions.ts";
import { splitMessage, toSlackMarkdown, truncateForSlack } from "./slack-formatter.ts";
import { extractTeamId, verifyGatewaySignature } from "./slack-gateway-verifier.ts";
import { type EventDispatchHost, type ReactionFn, registerHttpEventHandlers } from "./slack-http-events.ts";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

export type SlackHttpChannelConfig = {
	botToken: string;
	gatewaySigningSecret: string;
	teamId: string;
	installerUserId: string;
	teamName: string;
	listenPort: number;
	listenPath: string;
};

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";
type RequestWithRawBody = Request & { rawBody?: Buffer };

export class SlackHttpChannel implements Channel, EventDispatchHost {
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

	private readonly app: App;
	private readonly receiver: ExpressReceiver;
	private readonly teamId: string;
	private readonly installerUserId: string;
	private readonly teamName: string;
	private readonly gatewaySigningSecret: string;
	private readonly listenPort: number;
	private readonly listenPath: string;

	private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
	private reactionHandler: ReactionFn | null = null;
	private connectionState: ConnectionState = "disconnected";
	private botUserId: string | null = null;
	private phantomName = "Phantom";

	constructor(config: SlackHttpChannelConfig) {
		if (!config.botToken) throw new Error("SlackHttpChannel: botToken is required");
		if (!config.gatewaySigningSecret) throw new Error("SlackHttpChannel: gatewaySigningSecret is required");
		if (!config.teamId) throw new Error("SlackHttpChannel: teamId is required");

		this.teamId = config.teamId;
		this.installerUserId = config.installerUserId;
		this.teamName = config.teamName;
		this.gatewaySigningSecret = config.gatewaySigningSecret;
		this.listenPort = config.listenPort;
		this.listenPath = config.listenPath;

		// `signatureVerification: false` skips Slack-signing-secret verification
		// because the gateway has already verified Slack's signature, and we
		// will verify the gateway's HMAC ourselves.
		this.receiver = new ExpressReceiver({
			signingSecret: "phase-5b-unused-gateway-verifies-instead",
			signatureVerification: false,
			endpoints: {
				events: `${this.listenPath}/events`,
				interactive: `${this.listenPath}/interactivity`,
				commands: `${this.listenPath}/commands`,
			},
			processBeforeResponse: false,
			logLevel: "ERROR" as LogLevel,
		});

		this.installVerifier();

		this.app = new App({
			token: config.botToken,
			receiver: this.receiver,
			logLevel: "ERROR" as LogLevel,
		});
	}

	setPhantomName(name: string): void {
		this.phantomName = name;
	}
	getInstallerUserId(): string {
		return this.installerUserId;
	}
	getTeamId(): string {
		return this.teamId;
	}
	getTeamName(): string {
		return this.teamName;
	}
	getBotUserId(): string | null {
		return this.botUserId;
	}
	getPhantomName(): string {
		return this.phantomName;
	}
	getMessageHandler(): ((message: InboundMessage) => Promise<void>) | null {
		return this.messageHandler;
	}
	getReactionHandler(): ReactionFn | null {
		return this.reactionHandler;
	}
	getClient(): App["client"] {
		return this.app.client;
	}

	stripBotMention(text: string): string {
		if (this.botUserId) {
			return text.replace(new RegExp(`<@${this.botUserId}>\\s*`, "g"), "");
		}
		return text.replace(/^<@[A-Z0-9]+>\s*/, "");
	}

	/**
	 * Install Express middleware in front of Bolt's routes. Fails closed:
	 * missing headers return 401, tampered body fails the HMAC compare and
	 * returns 401, stale or future-skewed timestamp returns 401, foreign
	 * team_id returns 403.
	 */
	private installVerifier(): void {
		const expressApp = this.receiver.app;
		const guard = this.makeGuardMiddleware();
		expressApp.use(`${this.listenPath}/events`, guard);
		expressApp.use(`${this.listenPath}/interactivity`, guard);
		expressApp.use(`${this.listenPath}/commands`, guard);
	}

	private makeGuardMiddleware(): RequestHandler {
		const secret = this.gatewaySigningSecret;
		const expectedTeamId = this.teamId;

		return async (req: Request, res: Response, next): Promise<void> => {
			let raw: Buffer;
			try {
				raw = await readRequestBody(req as RequestWithRawBody);
			} catch {
				res.status(400).end("bad request");
				return;
			}

			(req as RequestWithRawBody).rawBody = raw;

			const sigHeader = headerString(req, "x-phantom-signature");
			const fwdHeader = headerString(req, "x-phantom-forwarded-at");
			const eventId = headerString(req, "x-phantom-slack-event-id");

			if (!verifyGatewaySignature({ sigHeader, fwdHeader, eventId, raw, secret })) {
				res.status(401).end("unauthorized");
				return;
			}

			const eventTeamId = extractTeamId(raw, getContentType(req));
			if (eventTeamId !== undefined && eventTeamId !== expectedTeamId) {
				res.status(403).end("forbidden");
				return;
			}

			rehydrateBody(req, raw);
			next();
		};
	}

	async connect(): Promise<void> {
		if (this.connectionState === "connected") return;
		this.connectionState = "connecting";

		registerHttpEventHandlers(this.app, this);
		registerSlackActions(this.app);

		try {
			// `auth.test` validates the bot token against Slack and returns the
			// bot user id. If the token has been revoked between OAuth callback
			// and tenant boot, this fails and we refuse to start.
			const authResult = await this.app.client.auth.test();
			this.botUserId = authResult.user_id ?? null;
			if (!this.botUserId) {
				this.connectionState = "error";
				throw new Error("auth.test returned no user_id; bot token may be revoked");
			}
			console.log(`[slack-http] Resolved bot user <@${this.botUserId}>`);

			await this.receiver.start(this.listenPort);
			this.connectionState = "connected";
			console.log(`[slack-http] Listening on :${this.listenPort}${this.listenPath}/{events,interactivity,commands}`);
		} catch (err: unknown) {
			this.connectionState = "error";
			const msg = err instanceof Error ? err.message : String(err);
			// Do NOT include any token material in error logs.
			console.error(`[slack-http] Failed to start: ${msg}`);
			throw err;
		}
	}

	async disconnect(): Promise<void> {
		if (this.connectionState === "disconnected") return;
		try {
			await this.receiver.stop();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[slack-http] Error during disconnect: ${msg}`);
		}
		this.connectionState = "disconnected";
		console.log("[slack-http] Disconnected");
	}

	async send(conversationId: string, message: OutboundMessage): Promise<SentMessage> {
		const { channel, threadTs } = parseConversationId(conversationId);
		const formattedText = toSlackMarkdown(message.text);
		const replyThreadTs = message.threadId ?? threadTs;
		const chunks = splitMessage(formattedText);
		let lastTs = "";
		for (const chunk of chunks) {
			const result = await this.app.client.chat.postMessage({
				channel,
				text: chunk,
				thread_ts: replyThreadTs,
			});
			lastTs = result.ts ?? "";
		}
		return {
			id: lastTs || randomUUID(),
			channelId: this.id,
			conversationId,
			timestamp: new Date(),
		};
	}

	onMessage(handler: (message: InboundMessage) => Promise<void>): void {
		this.messageHandler = handler;
	}

	onReaction(handler: ReactionFn): void {
		this.reactionHandler = handler;
	}

	isConnected(): boolean {
		return this.connectionState === "connected";
	}

	getConnectionState(): ConnectionState {
		return this.connectionState;
	}

	async postToChannel(channelId: string, text: string): Promise<string | null> {
		const formattedText = toSlackMarkdown(text);
		const chunks = splitMessage(formattedText);
		let lastTs: string | null = null;
		for (const chunk of chunks) {
			try {
				const result = await this.app.client.chat.postMessage({ channel: channelId, text: chunk });
				lastTs = result.ts ?? null;
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[slack-http] Failed to post to channel ${channelId}: ${msg}`);
				return null;
			}
		}
		return lastTs;
	}

	async sendDm(userId: string, text: string): Promise<string | null> {
		try {
			const openResult = await this.app.client.conversations.open({ users: userId });
			const dmChannelId = openResult.channel?.id;
			if (!dmChannelId) {
				console.error(`[slack-http] Failed to open DM with user ${userId}: no channel returned`);
				return null;
			}
			return this.postToChannel(dmChannelId, text);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[slack-http] Failed to send DM to user ${userId}: ${msg}`);
			return null;
		}
	}

	async postThinking(channel: string, threadTs: string): Promise<string | null> {
		try {
			const result = await this.app.client.chat.postMessage({
				channel,
				thread_ts: threadTs,
				text: "Working on it...",
			});
			return result.ts ?? null;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[slack-http] Failed to post thinking indicator: ${msg}`);
			return null;
		}
	}

	async updateMessage(channel: string, ts: string, text: string, blocks?: SlackBlock[]): Promise<void> {
		const formattedText = toSlackMarkdown(text);
		const truncated = truncateForSlack(formattedText);
		try {
			const updateArgs: Record<string, unknown> = { channel, ts, text: truncated };
			if (blocks) updateArgs.blocks = blocks;
			await this.app.client.chat.update(updateArgs as unknown as Parameters<typeof this.app.client.chat.update>[0]);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[slack-http] Failed to update message: ${msg}`);
		}
	}

	async updateWithFeedback(channel: string, ts: string, text: string): Promise<void> {
		const formattedText = toSlackMarkdown(text);
		const truncated = truncateForSlack(formattedText);
		const feedbackBlocks = buildFeedbackBlocks(ts);
		const blocks: SlackBlock[] = [{ type: "section", text: { type: "mrkdwn", text: truncated } }, ...feedbackBlocks];
		try {
			const updateArgs: Record<string, unknown> = { channel, ts, text: truncated, blocks };
			await this.app.client.chat.update(updateArgs as unknown as Parameters<typeof this.app.client.chat.update>[0]);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[slack-http] Failed to update message with feedback: ${msg}`);
		}
	}

	async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
		try {
			await this.app.client.reactions.add({ channel, timestamp: messageTs, name: emoji });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("already_reacted")) {
				console.warn(`[slack-http] Failed to add reaction :${emoji}:: ${msg}`);
			}
		}
	}

	async removeReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
		try {
			await this.app.client.reactions.remove({ channel, timestamp: messageTs, name: emoji });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("no_reaction")) {
				console.warn(`[slack-http] Failed to remove reaction :${emoji}:: ${msg}`);
			}
		}
	}
}

// --- helpers ---------------------------------------------------------------

function headerString(req: Request, name: string): string | null {
	const value = req.headers[name.toLowerCase()];
	if (Array.isArray(value)) return value[0] ?? null;
	return typeof value === "string" ? value : null;
}

function getContentType(req: Request): string {
	return headerString(req, "content-type") ?? "application/json";
}

async function readRequestBody(req: RequestWithRawBody): Promise<Buffer> {
	if (req.rawBody) {
		return Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody);
	}
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer | string) => {
			if (chunk == null) return;
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", (err: Error) => reject(err));
	});
}

/**
 * After we have consumed the request stream to verify HMAC, ExpressReceiver's
 * downstream body parser still expects to read a body. We pre-parse JSON or
 * urlencoded bodies onto `req.body` so subsequent middleware finds the
 * already-parsed payload via the standard Express convention.
 */
function rehydrateBody(req: Request, raw: Buffer): void {
	const ctype = getContentType(req).toLowerCase();
	if (ctype.includes("application/json")) {
		try {
			req.body = JSON.parse(raw.toString("utf-8"));
		} catch {
			// Leave body unset; downstream parser will surface the error.
		}
	} else if (ctype.includes("application/x-www-form-urlencoded")) {
		const params = new URLSearchParams(raw.toString("utf-8"));
		const obj: Record<string, string> = {};
		for (const [k, v] of params) obj[k] = v;
		req.body = obj;
	}
}

function parseConversationId(conversationId: string): { channel: string; threadTs: string | undefined } {
	const parts = conversationId.split(":");
	if (parts[1] === "dm") {
		return { channel: parts[2], threadTs: undefined };
	}
	return { channel: parts[1], threadTs: parts[2] };
}
