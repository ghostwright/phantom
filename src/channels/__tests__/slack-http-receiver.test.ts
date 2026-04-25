import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { signGatewayRequest } from "../slack-gateway-verifier.ts";

// Mock Slack Bolt's App and ExpressReceiver. The receiver shape we replace
// captures the registered Bolt handlers so the test driver can invoke them
// directly, mirroring the slack.test.ts pattern. The Express app sits on
// the receiver and exposes `use(path, mw)` so the channel's installVerifier
// can register guards we then drive end-to-end.
const mockStart = mock(() => Promise.resolve({}));
const mockStop = mock(() => Promise.resolve());
const mockAuthTest = mock(() => Promise.resolve({ user_id: "U_BOT123" }));
const mockPostMessage = mock(() => Promise.resolve({ ts: "1234567890.123456" }));
const mockChatUpdate = mock(() => Promise.resolve({ ok: true }));
const mockReactionsAdd = mock(() => Promise.resolve({ ok: true }));
const mockReactionsRemove = mock(() => Promise.resolve({ ok: true }));
const mockConversationsOpen = mock(() => Promise.resolve({ channel: { id: "D_DM_OPEN" } }));

type EventHandler = (...args: unknown[]) => Promise<void>;
type Middleware = (req: unknown, res: unknown, next: () => void) => unknown | Promise<unknown>;

const eventHandlers = new Map<string, EventHandler>();
const actionHandlers = new Map<string, EventHandler>();
const guards = new Map<string, Middleware>();

const expressApp = {
	use(path: string, mw: Middleware): void {
		guards.set(path, mw);
	},
};

const mockReceiver = {
	app: expressApp,
	start: mockStart,
	stop: mockStop,
};

const MockExpressReceiver = mock(() => mockReceiver);

const MockApp = mock(() => ({
	event: (name: string, handler: EventHandler) => {
		eventHandlers.set(name, handler);
	},
	action: (pattern: string | RegExp, handler: EventHandler) => {
		const key = pattern instanceof RegExp ? pattern.source : pattern;
		actionHandlers.set(key, handler);
	},
	client: {
		auth: { test: mockAuthTest },
		chat: { postMessage: mockPostMessage, update: mockChatUpdate },
		conversations: { open: mockConversationsOpen },
		reactions: { add: mockReactionsAdd, remove: mockReactionsRemove },
	},
}));

mock.module("@slack/bolt", () => ({
	App: MockApp,
	ExpressReceiver: MockExpressReceiver,
}));

// Import the channel AFTER the module mock so the constructor uses our doubles.
const { SlackHttpChannel } = await import("../slack-http-receiver.ts");
type SlackHttpChannelType = InstanceType<typeof SlackHttpChannel>;

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEAM_ID = "T9TK3CUKW";
const FOREIGN_TEAM_ID = "T_FOREIGN";

const baseConfig = {
	botToken: "xoxb-test-token",
	gatewaySigningSecret: SECRET,
	teamId: TEAM_ID,
	installerUserId: "U_INSTALLER",
	teamName: "Acme Corp",
	listenPort: 3100,
	listenPath: "/slack",
};

type MockReq = {
	headers: Record<string, string>;
	rawBody?: Buffer;
	body?: unknown;
	on?: (event: string, listener: (chunk?: Buffer) => void) => void;
};

type MockRes = {
	statusCode: number;
	body: string | undefined;
	status(code: number): MockRes;
	end(body?: string): void;
};

function makeRes(): MockRes {
	const res: MockRes = {
		statusCode: 0,
		body: undefined,
		status(code) {
			res.statusCode = code;
			return res;
		},
		end(body) {
			res.body = body;
		},
	};
	return res;
}

function makeReq(args: {
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
}): MockReq {
	const ctype = args.contentType ?? "application/json";
	const bodyText =
		typeof args.bodyJson === "string"
			? args.bodyJson
			: ctype.includes("urlencoded")
				? `payload=${encodeURIComponent(JSON.stringify(args.bodyJson))}`
				: JSON.stringify(args.bodyJson);
	const raw = Buffer.from(args.tamperedBody ?? bodyText);
	const now = args.now ?? Date.now();
	const fwd = args.staleMs !== undefined ? now - args.staleMs : args.futureMs !== undefined ? now + args.futureMs : now;
	const eventId = args.eventId ?? "Ev1";
	const sig = signGatewayRequest({
		forwardedAt: fwd,
		eventId,
		rawBody: Buffer.from(bodyText),
		secret: args.wrongSecret ? "wrong-secret" : SECRET,
	});
	const headers: Record<string, string> = { "content-type": ctype };
	if (!args.skipSig) headers["x-phantom-signature"] = sig;
	if (!args.skipFwd) headers["x-phantom-forwarded-at"] = String(fwd);
	headers["x-phantom-slack-event-id"] = eventId;
	const req: MockReq = { headers, rawBody: raw };
	// Provide req.on for the readRequestBody fallback path; not used when
	// rawBody is preset, but keeps the type contract honest for any guard
	// that re-reads the body.
	req.on = () => {};
	return req;
}

async function callGuard(channel: SlackHttpChannelType, path: string, req: MockReq): Promise<MockRes> {
	void channel;
	const guard = guards.get(path);
	if (!guard) throw new Error(`no guard at ${path}`);
	const res = makeRes();
	await new Promise<void>((resolve) => {
		const next = () => resolve();
		const out = guard(req, res, next);
		if (out instanceof Promise) {
			out.then(() => {
				if (res.statusCode !== 0) resolve();
			});
		} else if (res.statusCode !== 0) {
			resolve();
		}
	});
	return res;
}

beforeEach(() => {
	eventHandlers.clear();
	actionHandlers.clear();
	guards.clear();
	mockStart.mockClear();
	mockStop.mockClear();
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
	test("wires receiver and Bolt App with the provided config", () => {
		const channel = new SlackHttpChannel(baseConfig);
		expect(channel.id).toBe("slack");
		expect(channel.name).toBe("Slack");
		expect(channel.getTeamId()).toBe(TEAM_ID);
		expect(channel.getInstallerUserId()).toBe("U_INSTALLER");
		expect(channel.getTeamName()).toBe("Acme Corp");
		expect(MockExpressReceiver).toHaveBeenCalled();
		expect(MockApp).toHaveBeenCalled();
	});

	test("registers verifier guards on the three Slack endpoints", () => {
		new SlackHttpChannel(baseConfig);
		expect(guards.has("/slack/events")).toBe(true);
		expect(guards.has("/slack/interactivity")).toBe(true);
		expect(guards.has("/slack/commands")).toBe(true);
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

// ----- guard middleware ----------------------------------------------------

describe("guard middleware (HMAC + replay window + team_id)", () => {
	test("accepts a correctly-signed request and calls next()", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { type: "event_callback", team_id: TEAM_ID } });
		const res = await callGuard(channel, "/slack/events", req);
		expect(res.statusCode).toBe(0);
	});

	test("rejects 401 when X-Phantom-Signature is missing", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { team_id: TEAM_ID }, skipSig: true });
		const res = await callGuard(channel, "/slack/events", req);
		expect(res.statusCode).toBe(401);
	});

	test("rejects 401 when X-Phantom-Forwarded-At is missing", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { team_id: TEAM_ID }, skipFwd: true });
		const res = await callGuard(channel, "/slack/events", req);
		expect(res.statusCode).toBe(401);
	});

	test("rejects 401 on a stale forwarded-at (>5 minutes old)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({
			bodyJson: { team_id: TEAM_ID },
			staleMs: 6 * 60 * 1000,
		});
		const res = await callGuard(channel, "/slack/events", req);
		expect(res.statusCode).toBe(401);
	});

	test("rejects 401 on a future forwarded-at (>5 minutes ahead)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({
			bodyJson: { team_id: TEAM_ID },
			futureMs: 6 * 60 * 1000,
		});
		const res = await callGuard(channel, "/slack/events", req);
		expect(res.statusCode).toBe(401);
	});

	test("rejects 401 on tampered body (signature over original bytes)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({
			bodyJson: { team_id: TEAM_ID },
			tamperedBody: '{"team_id":"T_OTHER"}',
		});
		const res = await callGuard(channel, "/slack/events", req);
		expect(res.statusCode).toBe(401);
	});

	test("rejects 401 when signature was computed with a different secret", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { team_id: TEAM_ID }, wrongSecret: true });
		const res = await callGuard(channel, "/slack/events", req);
		expect(res.statusCode).toBe(401);
	});

	test("rejects 403 on team_id mismatch even with valid HMAC", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { team_id: FOREIGN_TEAM_ID } });
		const res = await callGuard(channel, "/slack/events", req);
		expect(res.statusCode).toBe(403);
	});

	test("accepts a request whose body has no team_id (e.g. url_verification ping)", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { type: "url_verification", challenge: "abc" } });
		const res = await callGuard(channel, "/slack/events", req);
		expect(res.statusCode).toBe(0);
	});

	test("accepts an interactivity payload (urlencoded form) when team.id matches", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({
			bodyJson: { type: "block_actions", team: { id: TEAM_ID, domain: "acme" } },
			contentType: "application/x-www-form-urlencoded",
		});
		const res = await callGuard(channel, "/slack/interactivity", req);
		expect(res.statusCode).toBe(0);
	});

	test("rejects 403 on interactivity payload with foreign team.id", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({
			bodyJson: { type: "block_actions", team: { id: FOREIGN_TEAM_ID, domain: "evil" } },
			contentType: "application/x-www-form-urlencoded",
		});
		const res = await callGuard(channel, "/slack/interactivity", req);
		expect(res.statusCode).toBe(403);
	});

	test("rehydrates JSON body for downstream Bolt parsers", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		const req = makeReq({ bodyJson: { team_id: TEAM_ID, foo: "bar" } });
		await callGuard(channel, "/slack/events", req);
		expect(req.body).toEqual({ team_id: TEAM_ID, foo: "bar" });
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

	test("connect transitions to connected state", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		await channel.connect();
		expect(channel.isConnected()).toBe(true);
		expect(channel.getConnectionState()).toBe("connected");
		expect(mockStart).toHaveBeenCalledTimes(1);
	});

	test("disconnect transitions back to disconnected", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		await channel.connect();
		await channel.disconnect();
		expect(channel.isConnected()).toBe(false);
		expect(channel.getConnectionState()).toBe("disconnected");
		expect(mockStop).toHaveBeenCalledTimes(1);
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

	test("disconnect on a never-connected channel is a no-op", async () => {
		const channel = new SlackHttpChannel(baseConfig);
		await channel.disconnect();
		expect(mockStop).toHaveBeenCalledTimes(0);
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

	test("event with no team_id and no defense default falls back to this.teamId (allow)", async () => {
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
		expect(received).toBe("hi");
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
