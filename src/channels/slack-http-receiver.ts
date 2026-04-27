// Phase 5b: HTTP receiver mode for Phantom Cloud tenants. Slack events are
// captured by a shared central gateway (phantom-slack-events), verified
// against Slack's signing secret there, then forwarded over HTTPS to the
// per-tenant Phantom on this VM. Self-hosters keep the Socket Mode flow at
// `slack.ts`; SLACK_TRANSPORT=http opts a tenant into this class.
//
// Three security layers operate at this boundary:
//   1. Caddy validates the gateway HMAC and strips inbound X-Phantom-* headers.
//   2. This class re-verifies the gateway HMAC via `slack-gateway-verifier`.
//   3. The parsed body's team_id MUST match the tenant's installer team_id.
//      The one body shape allowed without team_id is `url_verification`.
//
// `signatureVerification: false` on ExpressReceiver skips Slack's signing
// secret because the gateway has already verified Slack's signature.

import { App, ExpressReceiver, type LogLevel } from "@slack/bolt";
import type { Request, RequestHandler, Response } from "express";
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
import { extractTeamId, verifyGatewaySignature } from "./slack-gateway-verifier.ts";
import { type EventDispatchHost, type ReactionFn, registerHttpEventHandlers } from "./slack-http-events.ts";
import {
	type RequestWithRawBody,
	getContentType,
	headerString,
	isUrlVerificationBody,
	readRequestBody,
	redactTokens,
	rehydrateBody,
} from "./slack-http-utils.ts";
import { sendIntroductionDm } from "./slack-introduction.ts";
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

const LOG_TAG = "slack-http";

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
	// Phase B.1.4: instance-level guard against re-introducing the agent
	// after a transient disconnect+reconnect. A process restart resets it
	// (intentional: fresh user-visible DM beats silent UX failure).
	private firstDmSent = false;

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

	private egressContext(): EgressContext {
		return { client: this.app.client, channelId: this.id, logTag: LOG_TAG };
	}

	stripBotMention(text: string): string {
		if (this.botUserId) {
			return text.replace(new RegExp(`<@${this.botUserId}>\\s*`, "g"), "");
		}
		return text.replace(/^<@[A-Z0-9]+>\s*/, "");
	}

	// Fails closed: missing headers, tampered body, stale/future timestamp -> 401;
	// foreign or unknown team_id -> 403. Only `url_verification` may lack team_id.
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
			if (eventTeamId === undefined) {
				if (!isUrlVerificationBody(raw, getContentType(req))) {
					res.status(403).end("forbidden");
					return;
				}
			} else if (eventTeamId !== expectedTeamId) {
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
			// `auth.test` validates the bot token; a revoked token fails here.
			const authResult = await this.app.client.auth.test();
			this.botUserId = authResult.user_id ?? null;
			if (!this.botUserId) {
				this.connectionState = "error";
				throw new Error("auth.test returned no user_id; bot token may be revoked");
			}
			console.log(`[${LOG_TAG}] Resolved bot user <@${this.botUserId}>`);

			await this.receiver.start(this.listenPort);
			this.connectionState = "connected";
			console.log(`[${LOG_TAG}] Listening on :${this.listenPort}${this.listenPath}/{events,interactivity,commands}`);
		} catch (err: unknown) {
			this.connectionState = "error";
			const rawMsg = err instanceof Error ? err.message : String(err);
			// `redactTokens` defends against a future Bolt change emitting tokens.
			console.error(`[${LOG_TAG}] Failed to start: ${redactTokens(rawMsg)}`);
			throw err;
		}

		// Phase B.1.4: synthetic first DM. Fire after receiver.start so the
		// channel is wired before the user can reply; gate on firstDmSent so
		// a reconnect-after-drop does not re-introduce.
		if (!this.firstDmSent && this.installerUserId) {
			const result = await sendIntroductionDm({
				phantomName: this.phantomName,
				teamName: this.teamName,
				installerUserId: this.installerUserId,
				sendDm: (userId, text) => this.sendDm(userId, text),
			});
			if (result.sent) {
				this.firstDmSent = true;
			}
		}
	}

	async disconnect(): Promise<void> {
		if (this.connectionState === "disconnected") return;
		try {
			await this.receiver.stop();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[${LOG_TAG}] Error during disconnect: ${redactTokens(msg)}`);
		}
		this.connectionState = "disconnected";
		console.log(`[${LOG_TAG}] Disconnected`);
	}

	async send(conversationId: string, message: OutboundMessage): Promise<SentMessage> {
		return egressSend(this.egressContext(), conversationId, message);
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

	async updateWithFeedback(channel: string, ts: string, text: string): Promise<void> {
		return egressUpdateWithFeedback(this.egressContext(), channel, ts, text);
	}

	async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
		return egressAddReaction(this.egressContext(), channel, messageTs, emoji);
	}

	async removeReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
		return egressRemoveReaction(this.egressContext(), channel, messageTs, emoji);
	}
}
