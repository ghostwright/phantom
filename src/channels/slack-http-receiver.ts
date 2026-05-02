// HTTP receiver mode for hosted, operator-managed deployments. The Slack
// gateway (phantom-slack-events on the cpx22 host) verifies Slack-side
// HMAC and forwards each event to phantomd over mTLS gRPC; phantomd then
// signs the canonical request with the per-tenant gateway secret and
// POSTs to this in-VM Phantom on the host-side veth.
//
// On the in-VM side three security layers operate at this boundary:
//   1. The host-side veth firewall (phantomd_tenants nft chain) only
//      admits packets originating from the host network namespace.
//   2. `slack-gateway-verifier` re-verifies the gateway HMAC + replay
//      window over the raw bytes the gateway signed.
//   3. The parsed body's team_id MUST match the tenant's installer
//      team_id; the one body shape allowed without team_id is
//      `url_verification`, which we short-circuit before Bolt sees it.
//
// Why a Bun-native receiver instead of an ExpressReceiver:
// Phantom's `Bun.serve` already owns config.port (3100) for /health,
// /chat, /ui, /webhook, and /mcp. Spinning up a second HTTP listener on
// the same port is impossible (EADDRINUSE) and a separate port would
// require a second tenant ingress rule on every host. We mount the
// three Slack ingress paths on the existing Bun.serve via
// `tryHandleSlackHttp` (slack-http-routes.ts) and dispatch parsed
// events into Bolt's App via a tiny `BunReceiver` whose start/stop are
// no-ops. One process, one socket, no port collision.

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
import { type EventDispatchHost, type ReactionFn, registerHttpEventHandlers } from "./slack-http-events.ts";
import { BunReceiver, dispatchToBolt } from "./slack-http-handlers.ts";
import { redactTokens } from "./slack-http-utils.ts";
import { sendIntroductionDm } from "./slack-introduction.ts";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage, SentMessage } from "./types.ts";

/**
 * Persistent introduction ledger surface. The HTTP receiver consults
 * `isIntroSent` before firing the synthetic first DM and calls
 * `markIntroSent` only AFTER a successful Slack send. The wiring lives
 * in `index.ts` against the SQLite `onboarding_state` table; this
 * indirection keeps the channel free of a direct SQLite handle so the
 * unit tests do not have to spin up a database.
 *
 * Two outcomes the ledger pins:
 *   1. `/health.onboarding` flips from "pending" to "complete" after the
 *      first successful intro DM, mirroring the Socket Mode flow.
 *   2. A process restart never re-fires the intro DM once it has gone
 *      out (the in-memory `firstDmSent` flag was lost on restart and
 *      could re-DM the user; SQLite is now authoritative).
 *
 * Both callbacks are optional: when omitted (single-tenant dev / tests),
 * the channel falls back to the in-memory `firstDmSent` flag with the
 * same semantics it had before the ledger was introduced.
 */
export type IntroductionLedger = {
	isIntroSent(): boolean;
	markIntroSent(): void;
};

export type SlackHttpChannelConfig = {
	botToken: string;
	gatewaySigningSecret: string;
	teamId: string;
	installerUserId: string;
	teamName: string;
	/**
	 * Persistent intro-DM ledger. Production wires this against
	 * `onboarding_state` so the /health endpoint reports onboarding
	 * complete and a process restart does not re-DM the installer.
	 */
	introductionLedger?: IntroductionLedger;
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
	private readonly receiver: BunReceiver;
	private readonly teamId: string;
	private readonly installerUserId: string;
	private readonly teamName: string;
	private readonly gatewaySigningSecret: string;

	private messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
	private reactionHandler: ReactionFn | null = null;
	private connectionState: ConnectionState = "disconnected";
	private botUserId: string | null = null;
	private phantomName = "Phantom";
	// In-memory fallback when no persistent ledger is wired (tests,
	// single-tenant dev). Production reads/writes the SQLite ledger
	// passed in via `introductionLedger`; once the ledger is set it
	// is the authoritative source and this flag is unused.
	private firstDmSent = false;
	private readonly introductionLedger: IntroductionLedger | null;

	constructor(config: SlackHttpChannelConfig) {
		if (!config.botToken) throw new Error("SlackHttpChannel: botToken is required");
		if (!config.gatewaySigningSecret) throw new Error("SlackHttpChannel: gatewaySigningSecret is required");
		if (!config.teamId) throw new Error("SlackHttpChannel: teamId is required");

		this.teamId = config.teamId;
		this.installerUserId = config.installerUserId;
		this.teamName = config.teamName;
		this.gatewaySigningSecret = config.gatewaySigningSecret;
		this.introductionLedger = config.introductionLedger ?? null;

		// Bolt's `App` constructor calls `receiver.init(app)` synchronously
		// to wire the App reference; we reuse that App for processEvent
		// dispatches from the Bun handlers.
		this.receiver = new BunReceiver();
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

	// Public entrypoints invoked by `mountSlackHttpRoutes` against the
	// Bun.serve listener. Each runs the verifier guard, parses the body,
	// and dispatches the event into Bolt. Failure modes resolve to a
	// Response (401/403/400) rather than throwing so the Bun handler can
	// pipe them straight to the client without surrounding try/catch.
	async handleEvent(req: Request): Promise<Response> {
		return this.dispatch(req);
	}

	async handleInteractivity(req: Request): Promise<Response> {
		return this.dispatch(req);
	}

	async handleCommand(req: Request): Promise<Response> {
		return this.dispatch(req);
	}

	private async dispatch(req: Request): Promise<Response> {
		return dispatchToBolt({
			req,
			app: this.app,
			gatewaySigningSecret: this.gatewaySigningSecret,
			expectedTeamId: this.teamId,
			retryNumHeader: req.headers.get("x-slack-retry-num"),
			retryReasonHeader: req.headers.get("x-slack-retry-reason"),
		});
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

			this.connectionState = "connected";
			console.log(`[${LOG_TAG}] Ready; routes mounted on the shared Bun.serve listener`);
		} catch (err: unknown) {
			this.connectionState = "error";
			const rawMsg = err instanceof Error ? err.message : String(err);
			// `redactTokens` defends against a future Bolt change emitting tokens.
			console.error(`[${LOG_TAG}] Failed to start: ${redactTokens(rawMsg)}`);
			throw err;
		}

		// Synthetic first DM. Fire after the channel state flips to connected
		// so the user can reply immediately. Idempotency:
		//   - production wires `introductionLedger` against the SQLite
		//     onboarding_state table; a true ledger means the DM has
		//     already gone out (in this process or a prior restart) and
		//     we skip without retrying. The ledger is also what /health
		//     reads to flip onboarding from "pending" to "complete".
		//   - without a ledger (tests, single-tenant dev) we fall back
		//     to the in-memory `firstDmSent` flag; a restart re-fires.
		if (!this.installerUserId) {
			return;
		}
		if (this.introductionLedger?.isIntroSent() === true) {
			console.log(`[${LOG_TAG}] introduction ledger already records intro_sent; skipping intro DM`);
			return;
		}
		if (this.introductionLedger === null && this.firstDmSent) {
			return;
		}
		const result = await sendIntroductionDm({
			phantomName: this.phantomName,
			teamName: this.teamName,
			installerUserId: this.installerUserId,
			sendDm: (userId, text, blocks) => this.sendDm(userId, text, blocks),
		});
		if (result.sent) {
			this.firstDmSent = true;
			// The ledger is stamped only AFTER a successful Slack send so
			// a transient Slack failure leaves the row clear and the next
			// process start retries. This mirrors the Phase 12
			// firstboot_state pattern in the Socket Mode flow.
			if (this.introductionLedger !== null) {
				try {
					this.introductionLedger.markIntroSent();
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(`[${LOG_TAG}] introduction ledger markIntroSent failed: ${msg}`);
				}
			}
		}
	}

	async disconnect(): Promise<void> {
		if (this.connectionState === "disconnected") return;
		// No HTTP listener to stop here; the routes are mounted on the shared
		// Bun.serve owned by `core/server.ts`. We simply transition the
		// state machine so the /health channel flag flips to false and
		// downstream callers (router.disconnectAll, scheduler) see a
		// disconnected channel.
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

	async sendDm(userId: string, text: string, blocks?: SlackBlock[]): Promise<string | null> {
		return egressSendDm(this.egressContext(), userId, text, blocks);
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
