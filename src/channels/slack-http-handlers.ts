// HTTP-receiver handler glue for the in-VM Phantom. This file converts a
// Bun `Request` into a Bolt `ReceiverEvent` and dispatches it through the
// host channel. Pulling the conversion out of `slack-http-receiver.ts`
// keeps the channel class focused on lifecycle (auth.test, intro DM,
// state machine) and lets the receiver file stay under the 300-line
// budget enforced for the channels/ directory.
//
// Design note on "why a Bun handler instead of an ExpressReceiver":
// The Phantom process serves /health, /chat, /ui, /webhook, and now the
// Slack ingress on a single `Bun.serve` listener at config.port (3100).
// The previous code instantiated an `ExpressReceiver` and tried to
// `receiver.start(3100)`, which collided with the existing Bun.serve
// bind, failed with EADDRINUSE-equivalent semantics, and left
// `slackChannel.isConnected() === false`. That made `POST /slack/events`
// return 404 because the receiver routes never came up. One process, one
// listener, one socket; the Bun handler dispatches verified events
// straight into Bolt's `App.processEvent` via a tiny custom Receiver.

import type { App, Receiver, ReceiverEvent } from "@slack/bolt";
import { extractTeamId, verifyGatewaySignature } from "./slack-gateway-verifier.ts";
import { isUrlVerificationBody } from "./slack-http-utils.ts";

const HANDLER_LOG_TAG = "slack-http";

// Three Slack ingress paths Phantom mounts on the shared Bun.serve.
// These are pinned: phantom-slack-events on the gateway side targets
// these exact suffixes via the forwarder's tenant_url_template.
export const SLACK_HTTP_PATHS = {
	events: "/slack/events",
	interactivity: "/slack/interactivity",
	commands: "/slack/commands",
} as const;

// HTTP transport never sends a Slack response body in the inbound ack;
// we 200 with an empty body for every accepted event. Bolt's listener
// timing semantics (auto-ack within 3s, processBeforeResponse=false)
// match this since the actual user-facing reply is sent via
// `chat.postMessage` from the agent runtime, not as the inbound HTTP
// response.
const EMPTY_OK = (): Response => new Response("", { status: 200 });

// Bolt requires the `App` constructor to receive a `Receiver` whose
// `init(app)` is called synchronously. We don't bind a server here;
// the Bun handler is the receiver. `start` and `stop` are no-ops so
// `await app.start()` / `await app.stop()` (if ever called by Bolt
// internals) resolve cleanly. The widening at the App constructor
// site casts our minimal shape into Bolt's Receiver type.
export class BunReceiver implements Receiver {
	private bolt: App | null = null;

	init(app: App): void {
		this.bolt = app;
	}

	getBoltApp(): App | null {
		return this.bolt;
	}

	start(): Promise<unknown> {
		return Promise.resolve();
	}

	stop(): Promise<unknown> {
		return Promise.resolve();
	}
}

// Verifier outcome: either the parsed body the dispatcher should hand
// to Bolt, or a Response the caller returns directly to the client.
type VerifyOutcome =
	| { ok: true; body: Record<string, unknown>; rawBody: Buffer; contentType: string }
	| { ok: false; response: Response };

export type DispatchInput = {
	req: Request;
	gatewaySigningSecret: string;
	expectedTeamId: string;
};

// Verify the gateway HMAC, the replay window, and the team_id binding,
// then parse the raw body into the shape Bolt expects (JSON object for
// events, the inner JSON of `payload` for interactivity, the URLSearch
// dictionary for commands). Returns a Response on every short-circuit
// path so the caller can pipe it straight back to Bun.
export async function verifyAndParse(input: DispatchInput): Promise<VerifyOutcome> {
	const { req, gatewaySigningSecret, expectedTeamId } = input;

	let raw: Buffer;
	try {
		const buf = await req.arrayBuffer();
		raw = Buffer.from(buf);
	} catch {
		return { ok: false, response: new Response("bad request", { status: 400 }) };
	}

	const sigHeader = req.headers.get("x-phantom-signature");
	const fwdHeader = req.headers.get("x-phantom-forwarded-at");
	const eventId = req.headers.get("x-phantom-slack-event-id");
	const contentType = req.headers.get("content-type") ?? "application/json";

	if (!verifyGatewaySignature({ sigHeader, fwdHeader, eventId, raw, secret: gatewaySigningSecret })) {
		return { ok: false, response: new Response("unauthorized", { status: 401 }) };
	}

	// extractTeamId from slack-gateway-verifier.ts handles JSON events and
	// the urlencoded-with-`payload` shape used by interactivity. Slash
	// commands are urlencoded with top-level `team_id`; we extend the
	// extractor here (NOT in the verifier file, which is intentionally
	// kept pure for the events/interactivity contract) so the third
	// Slack ingress path can pass team binding without a verifier change.
	let eventTeamId = extractTeamId(raw, contentType);
	if (eventTeamId === undefined && contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
		const fromForm = new URLSearchParams(raw.toString("utf-8")).get("team_id");
		if (fromForm) eventTeamId = fromForm;
	}
	if (eventTeamId === undefined) {
		// `url_verification` is the one legitimate body shape with no team_id.
		// Anything else is foreign by contract: we reject defensively even
		// though the gateway already verified Slack-side authenticity.
		if (!isUrlVerificationBody(raw, contentType)) {
			return { ok: false, response: new Response("forbidden", { status: 403 }) };
		}
	} else if (eventTeamId !== expectedTeamId) {
		return { ok: false, response: new Response("forbidden", { status: 403 }) };
	}

	const body = parseRequestBody(raw, contentType);
	if (body === null) {
		return { ok: false, response: new Response("bad request", { status: 400 }) };
	}

	return { ok: true, body, rawBody: raw, contentType };
}

// Mirror of Bolt's ExpressReceiver `parseRequestBody`: JSON for
// application/json, inner JSON for `payload=...` urlencoded interactivity
// payloads, querystring object for everything else (slash commands).
// Returns null when the body cannot be parsed at all.
function parseRequestBody(raw: Buffer, contentType: string): Record<string, unknown> | null {
	const text = raw.toString("utf-8");
	const lower = contentType.toLowerCase();
	if (lower.includes("application/x-www-form-urlencoded")) {
		const params = new URLSearchParams(text);
		const payload = params.get("payload");
		if (typeof payload === "string") {
			try {
				return JSON.parse(payload) as Record<string, unknown>;
			} catch {
				return null;
			}
		}
		const obj: Record<string, unknown> = {};
		for (const [k, v] of params) obj[k] = v;
		return obj;
	}
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return null;
	}
}

// Build the AckFn the Bolt App calls when a listener finishes. The
// resulting Promise resolves to the Response we return to Bun. The
// hard timeout fallback (3s, matching Bolt's own
// unhandledRequestTimeoutMillis default) guarantees the Promise always
// settles even if a future Bolt regression were to drop the auto-ack;
// the operator-facing log makes the regression visible.
const ACK_TIMEOUT_MS = 3000;

type AckResolver = {
	ackFn: (response?: unknown) => Promise<void>;
	awaitAck: Promise<Response>;
};

function buildAckResolver(): AckResolver {
	let resolve!: (resp: Response) => void;
	const awaitAck = new Promise<Response>((r) => {
		resolve = r;
	});
	let acked = false;
	const settle = (resp: Response): void => {
		if (acked) return;
		acked = true;
		resolve(resp);
	};
	const ackFn = async (response?: unknown): Promise<void> => {
		if (response instanceof Error) {
			settle(new Response("", { status: 500 }));
			return;
		}
		if (response === undefined || response === null || response === "") {
			settle(EMPTY_OK());
			return;
		}
		if (typeof response === "string") {
			settle(new Response(response, { status: 200 }));
			return;
		}
		// Bolt action / view-submission listeners return a structured
		// response; we serialize as JSON so the Slack client receives a
		// well-formed body without a Content-Type sniff.
		settle(
			new Response(JSON.stringify(response), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	};
	const timer = setTimeout(() => {
		if (acked) return;
		console.warn(`[${HANDLER_LOG_TAG}] ack timeout after ${ACK_TIMEOUT_MS}ms; returning empty 200`);
		settle(EMPTY_OK());
	}, ACK_TIMEOUT_MS);
	// Don't keep the event loop alive purely for the timeout; the
	// awaitAck promise alone is what dispatchers wait on.
	if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
		timer.unref();
	}
	void awaitAck.then(() => clearTimeout(timer));
	return { ackFn, awaitAck };
}

export type DispatchToBoltInput = DispatchInput & {
	app: App;
	retryNumHeader?: string | null;
	retryReasonHeader?: string | null;
};

// Outcome of the ack-vs-processEvent race in `dispatchToBolt`. `ack`:
// a listener invoked AckFn (normal path). `process-ok`: processEvent
// resolved without any ack (Bolt regression; log + 200). `process-err`:
// processEvent rejected before ack (return 500; log the error message,
// never the Slack body).
type RaceOutcome = { kind: "ack"; resp: Response } | { kind: "process-ok" } | { kind: "process-err"; err: Error };

// Run the verifier guard and dispatch the parsed body into the Bolt
// `App`. `processEvent` invokes the registered listener middleware and
// calls our AckFn when a listener acks; we return that response to
// Bun. URL-verification bodies short-circuit with the challenge string,
// matching the path Bolt's HTTPReceiver takes before constructing a
// ReceiverEvent.
export async function dispatchToBolt(input: DispatchToBoltInput): Promise<Response> {
	const verified = await verifyAndParse(input);
	if (!verified.ok) return verified.response;

	if (verified.body.type === "url_verification" && typeof verified.body.challenge === "string") {
		return new Response(verified.body.challenge, {
			status: 200,
			headers: { "content-type": "text/plain" },
		});
	}

	const { ackFn, awaitAck } = buildAckResolver();
	const receiverEvent: ReceiverEvent = {
		body: verified.body,
		ack: ackFn,
		retryNum: parseRetryNum(input.retryNumHeader),
		retryReason: input.retryReasonHeader ?? undefined,
	};

	// Bolt's `processEvent` resolves when listener middleware finishes,
	// not when ack fires. Phantom's listener awaits `runtime.handleMessage`
	// which can outlast Slack's ~3s window. Replicate HTTPReceiver's
	// `processBeforeResponse: false` semantic by racing ack against
	// processEvent: ack winner returns the ack response; processEvent
	// rejecting before ack surfaces as 500.
	const ackTagged: Promise<RaceOutcome> = awaitAck.then((resp) => ({ kind: "ack", resp }));
	const processTagged: Promise<RaceOutcome> = input.app.processEvent(receiverEvent).then(
		(): RaceOutcome => ({ kind: "process-ok" }),
		(err: unknown): RaceOutcome => ({
			kind: "process-err",
			err: err instanceof Error ? err : new Error(String(err)),
		}),
	);

	const outcome = await Promise.race([ackTagged, processTagged]);
	if (outcome.kind === "ack") return outcome.resp;
	if (outcome.kind === "process-err") {
		console.error(`[${HANDLER_LOG_TAG}] processEvent rejected before ack: ${outcome.err.message}`);
		return new Response("internal server error", { status: 500 });
	}
	console.warn(`[${HANDLER_LOG_TAG}] processEvent resolved without ack; returning empty 200`);
	return EMPTY_OK();
}

function parseRetryNum(value: string | null | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : undefined;
}
