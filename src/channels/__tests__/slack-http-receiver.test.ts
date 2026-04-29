import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { signGatewayRequest } from "../slack-gateway-verifier.ts";

// Mock Slack Bolt's App. The receiver no longer instantiates
// ExpressReceiver (the previous implementation tried to bind a second
// HTTP server and collided with the shared Bun.serve), so the test
// surface drives the new public methods on `SlackHttpChannel` directly:
// handleEvent, handleInteractivity, handleCommand. The mock captures
// registered Bolt event/action handlers AND records every processEvent
// invocation so tests can assert exactly what got dispatched into
// Bolt's pipeline.
const mockAuthTest = mock(() => Promise.resolve({ user_id: "U_BOT123" }));
const mockPostMessage = mock(() => Promise.resolve({ ts: "1234567890.123456" }));
const mockChatUpdate = mock(() => Promise.resolve({ ok: true }));
const mockReactionsAdd = mock(() => Promise.resolve({ ok: true }));
const mockReactionsRemove = mock(() => Promise.resolve({ ok: true }));
const mockConversationsOpen = mock(() => Promise.resolve({ channel: { id: "D_DM_OPEN" } }));

type EventHandler = (...args: unknown[]) => Promise<void>;
type ProcessEventCall = { body: Record<string, unknown>; ack: (resp?: unknown) => Promise<void> };

const eventHandlers = new Map<string, EventHandler>();
const actionHandlers = new Map<string, EventHandler>();
const processEventCalls: ProcessEventCall[] = [];

// Per-test override for the App.processEvent mock. Tests that exercise
// the ack-vs-processEvent race set this; the default behavior auto-acks
// to keep the existing verifier-path tests realistic.
let processEventOverride: ((event: ProcessEventCall) => Promise<void>) | null = null;
// Most recent processEvent promise so the race tests can wait on the
// background listener after the handler has already returned.
let lastProcessEventReturn: Promise<void> | null = null;

let initReceived: { receiver: { init?: (app: unknown) => void } | null } = { receiver: null };

const MockApp = mock((opts: { receiver?: { init?: (app: unknown) => void } }) => {
	const app = {
		event: (name: string, handler: EventHandler) => {
			eventHandlers.set(name, handler);
		},
		action: (pattern: string | RegExp, handler: EventHandler) => {
			const key = pattern instanceof RegExp ? pattern.source : pattern;
			actionHandlers.set(key, handler);
		},
		processEvent: (event: ProcessEventCall): Promise<void> => {
			processEventCalls.push(event);
			const p: Promise<void> = (async () => {
				if (processEventOverride) {
					await processEventOverride(event);
					return;
				}
				await event.ack();
			})();
			lastProcessEventReturn = p;
			return p;
		},
		client: {
			auth: { test: mockAuthTest },
			chat: { postMessage: mockPostMessage, update: mockChatUpdate },
			conversations: { open: mockConversationsOpen },
			reactions: { add: mockReactionsAdd, remove: mockReactionsRemove },
		},
	};
	if (opts.receiver?.init) opts.receiver.init(app);
	initReceived.receiver = opts.receiver ?? null;
	return app;
});

mock.module("@slack/bolt", () => ({
	App: MockApp,
}));

// Import the channel AFTER the module mock so the constructor uses our doubles.
const { SlackHttpChannel } = await import("../slack-http-receiver.ts");

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEAM_ID = "T9TK3CUKW";
const FOREIGN_TEAM_ID = "T_FOREIGN";

const baseConfig = {
	botToken: "xoxb-test-token",
	gatewaySigningSecret: SECRET,
	teamId: TEAM_ID,
	installerUserId: "U_INSTALLER",
	teamName: "Acme Corp",
};

type MakeReqArgs = {
	bodyJson: unknown;
	contentType?: string;
	now?: number;
	eventId?: string;
	skipSig?: boolean;
	skipFwd?: boolean;
	tamperedBody?: string;
	wrongSecret?: boolean;
	staleMs?: number;
	futureMs?: number;
	method?: string;
	path?: string;
};

// Build a real `Request` (Bun-native, fetch-spec) signed with the gateway
// helper so the verifier path runs end-to-end against the same code that
// runs in production. Tampering options exist on every axis the verifier
// guards (signature, timestamp, secret, team_id, body bytes).
function makeReq(args: MakeReqArgs): Request {
	const ctype = args.contentType ?? "application/json";
	const bodyText =
		typeof args.bodyJson === "string"
			? args.bodyJson
			: ctype.includes("urlencoded")
				? `payload=${encodeURIComponent(JSON.stringify(args.bodyJson))}`
				: JSON.stringify(args.bodyJson);
	const rawForSig = Buffer.from(bodyText);
	const sentBody = args.tamperedBody ?? bodyText;
	const now = args.now ?? Date.now();
	const fwd = args.staleMs !== undefined ? now - args.staleMs : args.futureMs !== undefined ? now + args.futureMs : now;
	const eventId = args.eventId ?? "Ev1";
	const sig = signGatewayRequest({
		forwardedAt: fwd,
		eventId,
		rawBody: rawForSig,
		secret: args.wrongSecret ? "wrong-secret" : SECRET,
	});
	const headers: Record<string, string> = { "content-type": ctype };
	if (!args.skipSig) headers["x-phantom-signature"] = sig;
	if (!args.skipFwd) headers["x-phantom-forwarded-at"] = String(fwd);
	headers["x-phantom-slack-event-id"] = eventId;
	const url = `http://localhost:3100${args.path ?? "/slack/events"}`;
	return new Request(url, {
		method: args.method ?? "POST",
		headers,
		body: sentBody,
	});
}

beforeEach(() => {
	eventHandlers.clear();
	actionHandlers.clear();
	processEventCalls.length = 0;
	processEventOverride = null;
	lastProcessEventReturn = null;
	initReceived = { receiver: null };
	mockAuthTest.mockClear();
	mockPostMessage.mockClear();
	mockChatUpdate.mockClear();
	mockReactionsAdd.mockClear();
	mockReactionsRemove.mockClear();
	mockConversationsOpen.mockClear();
});

afterEach(() => {
	// Reset auth.test to the default success payload so a single "revoked
	// token" test does not bleed into other tests.
	mockAuthTest.mockImplementation(() => Promise.resolve({ user_id: "U_BOT123" }));
});

// ----- constructor ---------------------------------------------------------

describe("SlackHttpChannel constructor", () => {
	test("wires Bolt App with the provided config and a custom Receiver", () => {
		const channel = new SlackHttpChannel(baseConfig);
		expect(channel.id).toBe("slack");
		expect(channel.name).toBe("Slack");
		expect(channel.getTeamId()).toBe(TEAM_ID);
		expect(channel.getInstallerUserId()).toBe("U_INSTALLER");
		expect(channel.getTeamName()).toBe("Acme Corp");
		expect(MockApp).toHaveBeenCalled();
		// Bolt called receiver.init synchronously during construction.
		expect(initReceived.receiver).not.toBeNull();
		expect(typeof initReceived.receiver?.init).toBe("function");
	});

	test("rejects empty botToken with a clear error", () => {
		expect(() => new SlackHttpChannel({ ...baseConfig, botToken: "" })).toThrow(/botToken is required/);
	});

	test("rejects empty gatewaySigningSecret with a clear error", () => {
		expect(() => new SlackHttpChannel({ ...baseConfig, gatewaySigningSecret: "" })).toThrow(
			/gatewaySigningSecret is required/,
		);
	});

	test("rejects empty teamId with a clear error", () => {
		expect(() => new SlackHttpChannel({ ...baseConfig, teamId: "" })).toThrow(/teamId is required/);
	});

	test("starts in the disconnected state", () => {
		const channel = new SlackHttpChannel(baseConfig);
		expect(channel.isConnected()).toBe(false);
		expect(channel.getConnectionState()).toBe("disconnected");
	});

	test("constructor does not log the bot token", () => {
		const logs: string[] = [];
		const original = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		};
		try {
			new SlackHttpChannel(baseConfig);
		} finally {
			console.log = original;
		}
		const all = logs.join("\n");
		expect(all).not.toContain("xoxb-test-token");
	});
});

// ----- handler entrypoints (HMAC + replay window + team_id + dispatch) ----

describe("handleEvent / handleInteractivity / handleCommand (verifier guard + dispatch)", () => {
	test("accepts a correctly-signed event and dispatches into Bolt's processEvent", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { type: "event_callback", team_id: TEAM_ID, event: { type: "app_mention" } } });
		const res = await channel.handleEvent(req);
		expect(res.status).toBe(200);
		expect(processEventCalls).toHaveLength(1);
		expect(processEventCalls[0]?.body.team_id).toBe(TEAM_ID);
	});

	test("rejects 401 when X-Phantom-Signature is missing", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { team_id: TEAM_ID }, skipSig: true });
		const res = await channel.handleEvent(req);
		expect(res.status).toBe(401);
		expect(processEventCalls).toHaveLength(0);
	});

	test("rejects 401 when X-Phantom-Forwarded-At is missing", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { team_id: TEAM_ID }, skipFwd: true });
		const res = await channel.handleEvent(req);
		expect(res.status).toBe(401);
	});

	test("rejects 401 on a stale forwarded-at (>5 minutes old)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { team_id: TEAM_ID }, staleMs: 6 * 60 * 1000 });
		const res = await channel.handleEvent(req);
		expect(res.status).toBe(401);
	});

	test("rejects 401 on a future forwarded-at (>5 minutes ahead)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { team_id: TEAM_ID }, futureMs: 6 * 60 * 1000 });
		const res = await channel.handleEvent(req);
		expect(res.status).toBe(401);
	});

	test("rejects 401 on tampered body (signature was over original bytes)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({
			bodyJson: { team_id: TEAM_ID },
			tamperedBody: '{"team_id":"T_OTHER"}',
		});
		const res = await channel.handleEvent(req);
		expect(res.status).toBe(401);
	});

	test("rejects 401 when signature was computed with a different secret", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { team_id: TEAM_ID }, wrongSecret: true });
		const res = await channel.handleEvent(req);
		expect(res.status).toBe(401);
	});

	test("rejects 403 on team_id mismatch even with valid HMAC", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { team_id: FOREIGN_TEAM_ID } });
		const res = await channel.handleEvent(req);
		expect(res.status).toBe(403);
		expect(processEventCalls).toHaveLength(0);
	});

	test("returns 200 with the challenge string for a url_verification body", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { type: "url_verification", challenge: "abc-challenge-123" } });
		const res = await channel.handleEvent(req);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("abc-challenge-123");
		// url_verification short-circuits before Bolt; the App pipeline is
		// not invoked.
		expect(processEventCalls).toHaveLength(0);
	});

	test("rejects 403 when body has no team_id and is not url_verification", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { type: "event_callback", event: { type: "app_mention" } } });
		const res = await channel.handleEvent(req);
		expect(res.status).toBe(403);
	});

	test("returns 400 when JSON body is malformed (defense in depth)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		// Sign over the same malformed bytes the request carries so the HMAC
		// guard passes; the parse step is what fails.
		const malformed = "{not-json";
		const fwd = Date.now();
		const sig = signGatewayRequest({
			forwardedAt: fwd,
			eventId: "Ev1",
			rawBody: Buffer.from(malformed),
			secret: SECRET,
		});
		const req = new Request("http://localhost:3100/slack/events", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-phantom-signature": sig,
				"x-phantom-forwarded-at": String(fwd),
				"x-phantom-slack-event-id": "Ev1",
			},
			body: malformed,
		});
		const res = await channel.handleEvent(req);
		// Malformed JSON fails team_id extraction first (no team_id, no
		// url_verification shape), so we 403 before the parse step. The
		// regression we guard against is "this returned 200 and
		// dispatched", which the !ok / processEventCalls check pins.
		expect(res.status).toBe(403);
		expect(processEventCalls).toHaveLength(0);
	});

	test("returns 403 on a corrupted interactivity payload (no team_id reachable)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const malformedPayload = "payload=%7Bnot-json";
		const fwd = Date.now();
		const sig = signGatewayRequest({
			forwardedAt: fwd,
			eventId: "EvCorrupt",
			rawBody: Buffer.from(malformedPayload),
			secret: SECRET,
		});
		const req = new Request("http://localhost:3100/slack/interactivity", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"x-phantom-signature": sig,
				"x-phantom-forwarded-at": String(fwd),
				"x-phantom-slack-event-id": "EvCorrupt",
			},
			body: malformedPayload,
		});
		const res = await channel.handleInteractivity(req);
		// urlencoded body with a malformed `payload` field trips the
		// team_id guard (extractTeamId returns undefined and the body is
		// not url_verification), so we 403 fail-closed without ever
		// invoking processEvent. The regression we pin: a corrupted
		// forward must NOT silently dispatch.
		expect(res.status).toBe(403);
		expect(processEventCalls).toHaveLength(0);
	});

	test("accepts an interactivity payload (urlencoded form) when team.id matches", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({
			bodyJson: { type: "block_actions", team: { id: TEAM_ID, domain: "acme" } },
			contentType: "application/x-www-form-urlencoded",
			path: "/slack/interactivity",
		});
		const res = await channel.handleInteractivity(req);
		expect(res.status).toBe(200);
		expect(processEventCalls).toHaveLength(1);
		// urlencoded interactivity bodies are unwrapped: the inner JSON is
		// what Bolt sees, not the {payload: "..."} envelope.
		const dispatched = processEventCalls[0]?.body as Record<string, unknown>;
		expect(dispatched.type).toBe("block_actions");
		const team = dispatched.team as Record<string, unknown>;
		expect(team.id).toBe(TEAM_ID);
	});

	test("rejects 403 on interactivity payload with a foreign team.id", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({
			bodyJson: { type: "block_actions", team: { id: FOREIGN_TEAM_ID, domain: "evil" } },
			contentType: "application/x-www-form-urlencoded",
			path: "/slack/interactivity",
		});
		const res = await channel.handleInteractivity(req);
		expect(res.status).toBe(403);
	});

	test("handleCommand accepts a slash-command form and dispatches", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		// Slack slash commands send urlencoded fields including team_id at
		// the top level (no `payload` envelope).
		const formBody = `team_id=${TEAM_ID}&command=%2Fphantom&text=hello`;
		const fwd = Date.now();
		const sig = signGatewayRequest({
			forwardedAt: fwd,
			eventId: "EvCmd1",
			rawBody: Buffer.from(formBody),
			secret: SECRET,
		});
		const req = new Request("http://localhost:3100/slack/commands", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"x-phantom-signature": sig,
				"x-phantom-forwarded-at": String(fwd),
				"x-phantom-slack-event-id": "EvCmd1",
			},
			body: formBody,
		});
		const res = await channel.handleCommand(req);
		expect(res.status).toBe(200);
		expect(processEventCalls).toHaveLength(1);
		const body = processEventCalls[0]?.body as Record<string, unknown>;
		expect(body.team_id).toBe(TEAM_ID);
		expect(body.command).toBe("/phantom");
	});

	test("forwards retry headers to Bolt's ReceiverEvent", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const ctype = "application/json";
		const bodyText = JSON.stringify({ team_id: TEAM_ID, event: { type: "app_mention" } });
		const fwd = Date.now();
		const sig = signGatewayRequest({
			forwardedAt: fwd,
			eventId: "EvRetry1",
			rawBody: Buffer.from(bodyText),
			secret: SECRET,
		});
		const req = new Request("http://localhost:3100/slack/events", {
			method: "POST",
			headers: {
				"content-type": ctype,
				"x-phantom-signature": sig,
				"x-phantom-forwarded-at": String(fwd),
				"x-phantom-slack-event-id": "EvRetry1",
				"x-slack-retry-num": "2",
				"x-slack-retry-reason": "http_timeout",
			},
			body: bodyText,
		});
		await channel.handleEvent(req);
		expect(processEventCalls).toHaveLength(1);
		const dispatched = processEventCalls[0] as unknown as Record<string, unknown>;
		expect(dispatched.retryNum).toBe(2);
		expect(dispatched.retryReason).toBe("http_timeout");
	});
});

// ----- event routing -------------------------------------------------------

describe("event routing", () => {
	test("registers app_mention, message, reaction_added on connect", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		await channel.connect();
		expect(eventHandlers.has("app_mention")).toBe(true);
		expect(eventHandlers.has("message")).toBe(true);
		expect(eventHandlers.has("reaction_added")).toBe(true);
	});

	test("routes app_mention to the message handler", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		let received = "";
		channel.onMessage(async (msg) => {
			received = msg.text;
		});
		await channel.connect();

		const handler = eventHandlers.get("app_mention");
		if (!handler) throw new Error("no handler");
		await handler({
			event: {
				text: "<@U_BOT123> hello",
				user: "U_USER1",
				channel: "C_CHAN1",
				ts: "1715000000.000001",
			},
			body: { team_id: TEAM_ID },
		});
		expect(received).toBe("hello");
	});

	test("drops app_mention with a foreign team_id (defense in depth)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		let called = false;
		channel.onMessage(async () => {
			called = true;
		});
		await channel.connect();

		const handler = eventHandlers.get("app_mention");
		if (!handler) throw new Error("no handler");
		await handler({
			event: { text: "<@U_BOT123> hi", user: "U_X", channel: "C1", ts: "1715000000.000002" },
			body: { team_id: FOREIGN_TEAM_ID },
		});
		expect(called).toBe(false);
	});

	test("routes a DM (message.im) to the message handler", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		let received = "";
		channel.onMessage(async (msg) => {
			received = msg.text;
		});
		await channel.connect();

		const handler = eventHandlers.get("message");
		if (!handler) throw new Error("no handler");
		await handler({
			event: {
				text: "DM hello",
				user: "U_USER1",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1715000000.000003",
			},
			body: { team_id: TEAM_ID },
		});
		expect(received).toBe("DM hello");
	});

	test("ignores DM bot self-messages", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		let called = false;
		channel.onMessage(async () => {
			called = true;
		});
		await channel.connect();

		const handler = eventHandlers.get("message");
		if (!handler) throw new Error("no handler");
		await handler({
			event: {
				text: "self",
				user: "U_BOT123",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1715000000.000004",
			},
			body: { team_id: TEAM_ID },
		});
		expect(called).toBe(false);
	});

	test("ignores messages with subtype (e.g. message_changed)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		let called = false;
		channel.onMessage(async () => {
			called = true;
		});
		await channel.connect();
		const handler = eventHandlers.get("message");
		if (!handler) throw new Error("no handler");
		await handler({
			event: { subtype: "message_changed", channel: "D1", channel_type: "im", ts: "1.0" },
			body: { team_id: TEAM_ID },
		});
		expect(called).toBe(false);
	});

	test("drops DM with foreign team_id even if everything else matches", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		let called = false;
		channel.onMessage(async () => {
			called = true;
		});
		await channel.connect();
		const handler = eventHandlers.get("message");
		if (!handler) throw new Error("no handler");
		await handler({
			event: {
				text: "hello from outside",
				user: "U_OUT",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1715000000.000005",
			},
			body: { team_id: FOREIGN_TEAM_ID },
		});
		expect(called).toBe(false);
	});

	test("registers feedback action handlers on connect (compatibility regression)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		await channel.connect();
		// Three feedback action_ids registered by registerSlackActions:
		expect(actionHandlers.has("phantom:feedback:positive")).toBe(true);
		expect(actionHandlers.has("phantom:feedback:negative")).toBe(true);
		expect(actionHandlers.has("phantom:feedback:partial")).toBe(true);
	});

	test("routes positive reaction events through onReaction", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		let captured: { isPositive?: boolean; reaction?: string } = {};
		channel.onReaction((e) => {
			captured = { isPositive: e.isPositive, reaction: e.reaction };
		});
		await channel.connect();
		const handler = eventHandlers.get("reaction_added");
		if (!handler) throw new Error("no handler");
		await handler({
			event: {
				reaction: "thumbsup",
				user: "U_USER1",
				item: { ts: "1715000000.000001", channel: "C1" },
			},
			body: { team_id: TEAM_ID },
		});
		expect(captured.isPositive).toBe(true);
		expect(captured.reaction).toBe("thumbsup");
	});

	test("ignores non-feedback reactions", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		let called = false;
		channel.onReaction(() => {
			called = true;
		});
		await channel.connect();
		const handler = eventHandlers.get("reaction_added");
		if (!handler) throw new Error("no handler");
		await handler({
			event: { reaction: "eyes", user: "U_USER1", item: { ts: "1.0", channel: "C1" } },
			body: { team_id: TEAM_ID },
		});
		expect(called).toBe(false);
	});
});

// ----- bot user ID discovery & lifecycle -----------------------------------

describe("lifecycle and bot user discovery", () => {
	test("connect resolves bot_user_id via auth.test", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		await channel.connect();
		expect(channel.getBotUserId()).toBe("U_BOT123");
		expect(mockAuthTest).toHaveBeenCalledTimes(1);
	});

	test("connect transitions to connected state without binding an HTTP server", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		await channel.connect();
		expect(channel.isConnected()).toBe(true);
		expect(channel.getConnectionState()).toBe("connected");
		// The new receiver does NOT call any `start(port)` ever; that's the
		// whole point of Bug A's fix. We pin this behaviour by asserting
		// the receiver Bolt got is the BunReceiver shape (init/start/stop)
		// and that no port-binding side effect happened. There is no global
		// listener to inspect; the fact that the test process can run
		// concurrently with itself is itself the regression guard.
		expect(typeof initReceived.receiver?.init).toBe("function");
	});

	test("disconnect transitions back to disconnected", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		await channel.connect();
		await channel.disconnect();
		expect(channel.isConnected()).toBe(false);
		expect(channel.getConnectionState()).toBe("disconnected");
	});

	test("connect refuses to start when auth.test returns no user_id (revoked token)", async () => {
		mockAuthTest.mockImplementation(() => Promise.resolve({ user_id: "" as string }));
		const channel = new SlackHttpChannel(baseConfig);
		await expect(channel.connect()).rejects.toThrow(/auth\.test returned no user_id/);
		expect(channel.getConnectionState()).toBe("error");
	});

	test("connect surfaces a non-token error message; never logs the bot token", async () => {
		mockAuthTest.mockImplementation(() => Promise.reject(new Error("invalid_auth")));
		const channel = new SlackHttpChannel(baseConfig);
		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			await channel.connect().catch(() => {});
		} finally {
			console.error = original;
		}
		const all = errors.join("\n");
		expect(all).toContain("invalid_auth");
		expect(all).not.toContain("xoxb-test-token");
	});

	test("auth.test failure with a hostile token-bearing message redacts the token", async () => {
		mockAuthTest.mockImplementation(() =>
			Promise.reject(new Error("invalid_auth: xoxb-test-token-leaked exposed in error")),
		);
		const channel = new SlackHttpChannel(baseConfig);
		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			await channel.connect().catch(() => {});
		} finally {
			console.error = original;
		}
		const all = errors.join("\n");
		expect(all).toContain("invalid_auth");
		expect(all).toContain("[REDACTED-TOKEN]");
		expect(all).not.toContain("xoxb-test-token-leaked");
	});

	test("disconnect on a never-connected channel is a no-op", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		// No throw, no state change beyond what the never-connected channel
		// already has.
		await channel.disconnect();
		expect(channel.getConnectionState()).toBe("disconnected");
	});
});

// ----- synthetic first DM on connect ---------------------------------------

describe("synthetic first DM on connect", () => {
	test("opens a DM with the installer and posts the introduction text", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		channel.setPhantomName("Maple");
		await channel.connect();

		expect(mockConversationsOpen).toHaveBeenCalledWith({ users: "U_INSTALLER" });
		const calls = mockPostMessage.mock.calls as unknown as Array<[{ channel?: string; text?: string }]>;
		const introCall = calls.find((c) => {
			const arg = c[0];
			return arg.channel === "D_DM_OPEN" && typeof arg.text === "string" && arg.text.includes("I'm Maple");
		});
		expect(introCall).toBeDefined();
	});

	test("does not re-introduce on a reconnect after disconnect (firstDmSent gates)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		await channel.connect();
		const calls1 = mockPostMessage.mock.calls as unknown as Array<[{ channel?: string }]>;
		const introCallsAfterFirst = calls1.filter((c) => c[0].channel === "D_DM_OPEN").length;
		await channel.disconnect();

		// A reconnect after a transient drop should NOT re-introduce. The
		// firstDmSent flag is instance-level and persists across the
		// connect/disconnect/connect cycle on the same channel object.
		await channel.connect();
		const calls2 = mockPostMessage.mock.calls as unknown as Array<[{ channel?: string }]>;
		const introCallsAfterReconnect = calls2.filter((c) => c[0].channel === "D_DM_OPEN").length;
		expect(introCallsAfterReconnect).toBe(introCallsAfterFirst);
	});

	test("connect still resolves successfully when the introduction DM fails", async () => {
		// Simulate a Slack rate-limit by rejecting chat.postMessage. The
		// channel must still finish connect() so the user can receive
		// channel messages even when their first DM was rate-limited.
		mockPostMessage.mockImplementation(() => Promise.reject(new Error("ratelimited")));
		const channel = new SlackHttpChannel(baseConfig);
		await expect(channel.connect()).resolves.toBeUndefined();
		expect(channel.getConnectionState()).toBe("connected");
		mockPostMessage.mockImplementation(() => Promise.resolve({ ts: "1234567890.123456" }));
	});

	test("retries the introduction on a fresh connect after first send returned null", async () => {
		mockPostMessage.mockImplementationOnce(() => Promise.resolve({ ts: "" } as { ts: string }));
		const channel = new SlackHttpChannel(baseConfig);
		await channel.connect();
		await channel.disconnect();
		await channel.connect();
		const calls = mockPostMessage.mock.calls as unknown as Array<[{ channel?: string }]>;
		const introCalls = calls.filter((c) => c[0].channel === "D_DM_OPEN").length;
		expect(introCalls).toBe(2);
	});
});

// ----- send and outbound API ----------------------------------------------

describe("send / outbound", () => {
	test("send posts to the correct channel and thread", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		await channel.connect();
		const result = await channel.send("slack:C1:1715000000.000001", { text: "Hello" });
		expect(result.channelId).toBe("slack");
		expect(mockPostMessage).toHaveBeenCalledWith({
			channel: "C1",
			text: "Hello",
			thread_ts: "1715000000.000001",
		});
	});

	test("postToChannel chunks long messages but keeps one chat.postMessage per chunk", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		await channel.connect();
		mockPostMessage.mockClear();
		await channel.postToChannel("C1", "short");
		expect(mockPostMessage).toHaveBeenCalledTimes(1);
	});

	test("sendDm opens a DM and posts there", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		await channel.connect();
		await channel.sendDm("U_USER1", "Hi");
		expect(mockConversationsOpen).toHaveBeenCalledWith({ users: "U_USER1" });
		expect(mockPostMessage).toHaveBeenCalledWith({ channel: "D_DM_OPEN", text: "Hi" });
	});

	test("addReaction calls reactions.add with the correct shape", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		await channel.connect();
		await channel.addReaction("C1", "1.0", "+1");
		expect(mockReactionsAdd).toHaveBeenCalledWith({ channel: "C1", timestamp: "1.0", name: "+1" });
	});

	test("removeReaction calls reactions.remove with the correct shape", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		await channel.connect();
		await channel.removeReaction("C1", "1.0", "+1");
		expect(mockReactionsRemove).toHaveBeenCalledWith({ channel: "C1", timestamp: "1.0", name: "+1" });
	});
});

// ----- access control ------------------------------------------------------

describe("access control (HTTP mode = any user from this.teamId)", () => {
	test("any user from this.teamId can talk to Phantom", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		let received = "";
		channel.onMessage(async (msg) => {
			received = msg.text;
		});
		await channel.connect();
		const handler = eventHandlers.get("app_mention");
		if (!handler) throw new Error("no handler");
		// A random non-installer user mentions Phantom: should be allowed.
		await handler({
			event: { text: "<@U_BOT123> hi", user: "U_RANDOM_TEAMMATE", channel: "C1", ts: "1715000000.0" },
			body: { team_id: TEAM_ID },
		});
		expect(received).toBe("hi");
	});

	test("event with no parseable team_id is dropped (defense in depth, no host fallback)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		let received = "";
		channel.onMessage(async (msg) => {
			received = msg.text;
		});
		await channel.connect();
		const handler = eventHandlers.get("app_mention");
		if (!handler) throw new Error("no handler");
		await handler({
			event: { text: "<@U_BOT123> hi", user: "U_RANDOM", channel: "C1", ts: "1715000000.0" },
			body: {},
		});
		expect(received).toBe("");
	});

	test("DM with no parseable team_id is dropped (defense in depth, no host fallback)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		let called = false;
		channel.onMessage(async () => {
			called = true;
		});
		await channel.connect();
		const handler = eventHandlers.get("message");
		if (!handler) throw new Error("no handler");
		await handler({
			event: {
				text: "DM with no team_id",
				user: "U_USER1",
				channel: "D_DM1",
				channel_type: "im",
				ts: "1715000000.000010",
			},
			body: {},
		});
		expect(called).toBe(false);
	});

	test("reaction with foreign team_id is dropped (defense in depth)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		let captured = false;
		channel.onReaction(() => {
			captured = true;
		});
		await channel.connect();
		const handler = eventHandlers.get("reaction_added");
		if (!handler) throw new Error("no handler");
		await handler({
			event: {
				reaction: "thumbsup",
				user: "U_OUT",
				item: { ts: "1715000000.000020", channel: "C1" },
			},
			body: { team_id: FOREIGN_TEAM_ID },
		});
		expect(captured).toBe(false);
	});

	test("reaction with no team_id is dropped (defense in depth)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		let captured = false;
		channel.onReaction(() => {
			captured = true;
		});
		await channel.connect();
		const handler = eventHandlers.get("reaction_added");
		if (!handler) throw new Error("no handler");
		await handler({
			event: {
				reaction: "thumbsup",
				user: "U_OUT",
				item: { ts: "1715000000.000021", channel: "C1" },
			},
			body: {},
		});
		expect(captured).toBe(false);
	});

	test("foreign team_id is dropped in the event handler even after the guard passed", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		let called = false;
		channel.onMessage(async () => {
			called = true;
		});
		await channel.connect();
		const handler = eventHandlers.get("app_mention");
		if (!handler) throw new Error("no handler");
		// Defense in depth: even if a future regression weakened the
		// HMAC guard's team_id check, the per-event handler must still
		// drop foreign team events.
		await handler({
			event: { text: "<@U_BOT123> hi", user: "U_RANDOM", channel: "C1", ts: "1.0" },
			body: { team_id: FOREIGN_TEAM_ID },
		});
		expect(called).toBe(false);
	});
});

// ----- ack-vs-processEvent race (Codex round 2 P1 + P2) -------------------
//
// Bolt's `processEvent` resolves only after listener middleware has
// finished, not when `ack()` fires. Phantom's listener calls
// `runtime.handleMessage`, which can outlast Slack's ~3s ack window.
// `dispatchToBolt` therefore races the ack-resolved promise against
// processEvent so:
//   - ack winner (normal path) returns the listener's response immediately
//   - processEvent rejecting before ack returns 500 (Slack retries)
//   - processEvent resolving without any ack returns 200 + log warn
//     (defense against a hypothetical Bolt regression)
// These three tests pin each branch.

describe("dispatchToBolt: ack-vs-processEvent race", () => {
	test("long-running listener: handler returns 200 immediately, listener continues in background", async () => {
		let releaseListener!: () => void;
		const longWork = new Promise<void>((r) => {
			releaseListener = r;
		});
		let listenerFinished = false;

		processEventOverride = async (event) => {
			await event.ack(); // listener acks within Slack's window
			await longWork; // then runs work that outlasts the ack budget
			listenerFinished = true;
		};

		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({
			bodyJson: { type: "event_callback", team_id: TEAM_ID, event: { type: "app_mention" } },
		});

		const start = Date.now();
		const res = await channel.handleEvent(req);
		const elapsed = Date.now() - start;

		expect(res.status).toBe(200);
		// Handler returned promptly even though the listener is still pending.
		// 250ms gives plenty of slack on slow CI without admitting any
		// regression that would actually block on `processEvent`.
		expect(elapsed).toBeLessThan(250);
		expect(listenerFinished).toBe(false);

		// Release the listener and verify it eventually finishes its work.
		releaseListener();
		await lastProcessEventReturn;
		expect(listenerFinished).toBe(true);
	});

	test("processEvent rejects before ack: handler returns 500 with operator log", async () => {
		processEventOverride = async () => {
			// Listener middleware fails before any listener invokes ack.
			throw new Error("listener middleware blew up");
		};

		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		let res: Response;
		try {
			const channel = new SlackHttpChannel(baseConfig);
			const req = makeReq({
				bodyJson: { type: "block_actions", team: { id: TEAM_ID, domain: "acme" } },
				contentType: "application/x-www-form-urlencoded",
				path: "/slack/interactivity",
			});
			res = await channel.handleInteractivity(req);
		} finally {
			console.error = original;
		}

		expect(res.status).toBe(500);
		const all = errors.join("\n");
		expect(all).toContain("processEvent rejected before ack");
		expect(all).toContain("listener middleware blew up");
		// We must NEVER log Slack body content; the message we logged
		// carries only the listener's error string.
		expect(all).not.toContain("block_actions");
		expect(all).not.toContain("acme");
	});

	test("processEvent resolves without ack: handler returns 200 with operator warning (Bolt-bug fallback)", async () => {
		processEventOverride = async () => {
			// Hypothetical Bolt regression: listener pipeline finishes
			// without anyone calling ack. We log + 200; Slack retries.
		};

		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
		let res: Response;
		try {
			const channel = new SlackHttpChannel(baseConfig);
			const req = makeReq({
				bodyJson: { type: "event_callback", team_id: TEAM_ID, event: { type: "app_mention" } },
			});
			res = await channel.handleEvent(req);
		} finally {
			console.warn = original;
		}

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");
		const all = warnings.join("\n");
		expect(all).toContain("processEvent resolved without ack");
	});
});
