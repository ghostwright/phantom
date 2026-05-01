import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import promClient from "prom-client";
import { NoopSlackMetrics, SlackMetrics, type SlackSocketState } from "../slack-metrics.ts";

// Mock the Slack Bolt SDK so importing SlackChannel below does not pull
// the real WebSocket client at module load. We re-use the same pattern
// the other Slack channel tests use; SocketModeReceiver returns a stub
// whose `client.on(...)` records listeners into a per-test map so we can
// fire lifecycle events synthetically.
type SocketEventHandler = (...args: unknown[]) => void;
const socketClientListeners = new Map<string, SocketEventHandler[]>();
function fireSocketEvent(event: string, ...args: unknown[]): void {
	for (const fn of socketClientListeners.get(event) ?? []) {
		fn(...args);
	}
}
function resetSocketListeners(): void {
	socketClientListeners.clear();
}

const MockSocketModeReceiver = mock(() => ({
	client: {
		on: (event: string, listener: SocketEventHandler) => {
			const list = socketClientListeners.get(event) ?? [];
			list.push(listener);
			socketClientListeners.set(event, list);
		},
	},
}));

type AppMiddleware = (args: { body: unknown; next: () => Promise<void> }) => Promise<void>;
const middlewares: AppMiddleware[] = [];

const MockApp = mock(() => ({
	start: () => Promise.resolve(),
	stop: () => Promise.resolve(),
	event: () => {},
	action: () => {},
	use: (m: AppMiddleware) => {
		middlewares.push(m);
	},
	client: {
		auth: { test: () => Promise.resolve({ user_id: "U_BOT" }) },
		chat: {
			postMessage: () => Promise.resolve({ ts: "1.0" }),
			update: () => Promise.resolve({ ok: true }),
		},
		conversations: { open: () => Promise.resolve({ channel: { id: "D1" } }) },
		reactions: {
			add: () => Promise.resolve({ ok: true }),
			remove: () => Promise.resolve({ ok: true }),
		},
	},
}));

mock.module("@slack/bolt", () => ({
	App: MockApp,
	SocketModeReceiver: MockSocketModeReceiver,
}));

const { SlackChannel } = await import("../slack.ts");
const { extractEventType } = await import("../slack.ts");

const ALL_STATES: SlackSocketState[] = [
	"connecting",
	"authenticated",
	"connected",
	"reconnecting",
	"disconnecting",
	"disconnected",
	"error",
];

/**
 * Helper: parse the prom-client text-format dump and return the value of
 * the labeled gauge series with the given state. The text format is
 * `<metric_name>{label="value"} <number>` per line; histograms expand to
 * `_bucket`, `_sum`, `_count`, which we ignore here.
 */
function readGauge(text: string, metric: string, state: string): number | null {
	const re = new RegExp(`^${metric}\\{state="${state}"\\}\\s+(\\S+)`, "m");
	const m = re.exec(text);
	if (!m) return null;
	return Number.parseFloat(m[1] ?? "");
}

function readCounter(text: string, metric: string): number | null {
	const re = new RegExp(`^${metric}(?:\\{[^}]*\\})?\\s+(\\S+)`, "m");
	const m = re.exec(text);
	if (!m) return null;
	return Number.parseFloat(m[1] ?? "");
}

function readHistogramCount(text: string, metric: string, labelMatch?: string): number | null {
	const labelClause = labelMatch ? `\\{${labelMatch}\\}` : "(?:\\{[^}]*\\})?";
	const re = new RegExp(`^${metric}_count${labelClause}\\s+(\\S+)`, "m");
	const m = re.exec(text);
	if (!m) return null;
	return Number.parseFloat(m[1] ?? "");
}

describe("SlackMetrics", () => {
	let registry: promClient.Registry;
	let metrics: SlackMetrics;

	beforeEach(() => {
		registry = new promClient.Registry();
		metrics = new SlackMetrics(registry);
		resetSocketListeners();
		middlewares.length = 0;
	});

	afterEach(() => {
		registry.clear();
	});

	test("registers all four metric families on construction", async () => {
		const text = await registry.metrics();
		expect(text).toContain("phantom_slack_socket_state");
		expect(text).toContain("phantom_slack_socket_reconnects_total");
		expect(text).toContain("phantom_slack_socket_connection_seconds");
		expect(text).toContain("phantom_slack_event_dispatch_seconds");
	});

	test("initializes every state series at 0 before any lifecycle event", async () => {
		const text = await registry.metrics();
		for (const s of ALL_STATES) {
			expect(readGauge(text, "phantom_slack_socket_state", s)).toBe(0);
		}
	});

	test("recordState(connected) sets connected=1 and others=0", async () => {
		metrics.recordState("connected");
		const text = await registry.metrics();
		expect(readGauge(text, "phantom_slack_socket_state", "connected")).toBe(1);
		for (const s of ALL_STATES.filter((x) => x !== "connected")) {
			expect(readGauge(text, "phantom_slack_socket_state", s)).toBe(0);
		}
	});

	test("recordState transitions overwrite the previous state", async () => {
		metrics.recordState("connecting");
		metrics.recordState("authenticated");
		metrics.recordState("connected");
		metrics.recordState("disconnected");
		const text = await registry.metrics();
		expect(readGauge(text, "phantom_slack_socket_state", "disconnected")).toBe(1);
		expect(readGauge(text, "phantom_slack_socket_state", "connected")).toBe(0);
		expect(readGauge(text, "phantom_slack_socket_state", "authenticated")).toBe(0);
		expect(readGauge(text, "phantom_slack_socket_state", "connecting")).toBe(0);
	});

	test("recordState handles the error pseudo-state", async () => {
		metrics.recordState("error");
		const text = await registry.metrics();
		expect(readGauge(text, "phantom_slack_socket_state", "error")).toBe(1);
		expect(readGauge(text, "phantom_slack_socket_state", "connected")).toBe(0);
	});

	test("recordReconnect increments the counter", async () => {
		metrics.recordReconnect();
		metrics.recordReconnect();
		metrics.recordReconnect();
		const text = await registry.metrics();
		expect(readCounter(text, "phantom_slack_socket_reconnects_total")).toBe(3);
	});

	test("observeConnectionDuration records a histogram observation", async () => {
		metrics.observeConnectionDuration(42);
		const text = await registry.metrics();
		expect(readHistogramCount(text, "phantom_slack_socket_connection_seconds")).toBe(1);
	});

	test("observeConnectionDuration silently drops negative input", async () => {
		metrics.observeConnectionDuration(-5);
		metrics.observeConnectionDuration(Number.NaN);
		metrics.observeConnectionDuration(Number.POSITIVE_INFINITY);
		const text = await registry.metrics();
		expect(readHistogramCount(text, "phantom_slack_socket_connection_seconds")).toBe(0);
	});

	test("observeEventDispatch labels by event type", async () => {
		metrics.observeEventDispatch("app_mention", 0.123);
		metrics.observeEventDispatch("app_mention", 0.456);
		metrics.observeEventDispatch("message", 0.7);
		const text = await registry.metrics();
		expect(readHistogramCount(text, "phantom_slack_event_dispatch_seconds", `event_type="app_mention"`)).toBe(2);
		expect(readHistogramCount(text, "phantom_slack_event_dispatch_seconds", `event_type="message"`)).toBe(1);
	});
});

describe("NoopSlackMetrics", () => {
	test("every method is a no-op (does not throw on any input)", () => {
		const noop = new NoopSlackMetrics();
		expect(() => noop.recordState("connected")).not.toThrow();
		expect(() => noop.recordReconnect()).not.toThrow();
		expect(() => noop.observeConnectionDuration(123)).not.toThrow();
		expect(() => noop.observeConnectionDuration(-5)).not.toThrow();
		expect(() => noop.observeEventDispatch("event", 0.5)).not.toThrow();
	});
});

describe("extractEventType", () => {
	test("returns body.event.type when present", () => {
		expect(extractEventType({ event: { type: "app_mention" } })).toBe("app_mention");
		expect(extractEventType({ event: { type: "message" } })).toBe("message");
	});

	test("falls back to body.type for envelopes without an inner event", () => {
		expect(extractEventType({ type: "block_actions" })).toBe("block_actions");
		expect(extractEventType({ type: "view_submission" })).toBe("view_submission");
	});

	test("body.event.type wins over body.type", () => {
		expect(extractEventType({ type: "envelope", event: { type: "reaction_added" } })).toBe("reaction_added");
	});

	test("returns 'unknown' for missing or non-string types", () => {
		expect(extractEventType({})).toBe("unknown");
		expect(extractEventType({ type: 42 })).toBe("unknown");
		expect(extractEventType({ event: {} })).toBe("unknown");
		expect(extractEventType({ event: null })).toBe("unknown");
		expect(extractEventType(null)).toBe("unknown");
		expect(extractEventType(undefined)).toBe("unknown");
		expect(extractEventType("string")).toBe("unknown");
	});
});

// SlackChannel + SlackMetrics integration tests. These verify the wiring
// between the Bolt SocketModeReceiver lifecycle events and the metrics
// emitter, which is the production failure surface (a hooked-but-broken
// emitter ships zero metrics and the fleet view goes silent).
describe("SlackChannel lifecycle hooks emit metrics", () => {
	let registry: promClient.Registry;
	let metrics: SlackMetrics;

	beforeEach(() => {
		registry = new promClient.Registry();
		metrics = new SlackMetrics(registry);
		resetSocketListeners();
		middlewares.length = 0;
	});

	afterEach(() => {
		registry.clear();
	});

	test("constructing SlackChannel attaches all six lifecycle listeners", () => {
		// Construction is the side effect under test: the SlackChannel ctor
		// attaches the lifecycle listeners and the dispatch middleware.
		new SlackChannel({
			botToken: "xoxb-test",
			appToken: "xapp-test",
			metrics,
		});
		// Bolt's underlying SocketModeClient emits these six lifecycle events
		// (verbatim from @slack/socket-mode/dist/src/SocketModeClient.js State enum).
		const expected = ["connecting", "authenticated", "connected", "reconnecting", "disconnecting", "disconnected"];
		for (const e of expected) {
			expect(socketClientListeners.has(e)).toBe(true);
			expect((socketClientListeners.get(e) ?? []).length).toBeGreaterThanOrEqual(1);
		}
	});

	test("constructor pre-emits 'disconnected' so /metrics scrapes are complete pre-connect", async () => {
		// Construction is the side effect under test: the SlackChannel ctor
		// attaches the lifecycle listeners and the dispatch middleware.
		new SlackChannel({
			botToken: "xoxb-test",
			appToken: "xapp-test",
			metrics,
		});
		const text = await registry.metrics();
		expect(readGauge(text, "phantom_slack_socket_state", "disconnected")).toBe(1);
		expect(readGauge(text, "phantom_slack_socket_state", "connected")).toBe(0);
	});

	test("firing the 'connected' event flips the gauge", async () => {
		// Construction is the side effect under test: the SlackChannel ctor
		// attaches the lifecycle listeners and the dispatch middleware.
		new SlackChannel({
			botToken: "xoxb-test",
			appToken: "xapp-test",
			metrics,
		});
		fireSocketEvent("connected");
		const text = await registry.metrics();
		expect(readGauge(text, "phantom_slack_socket_state", "connected")).toBe(1);
		expect(readGauge(text, "phantom_slack_socket_state", "disconnected")).toBe(0);
	});

	test("'reconnecting' event increments the reconnect counter and observes connection duration", async () => {
		// Construction is the side effect under test: the SlackChannel ctor
		// attaches the lifecycle listeners and the dispatch middleware.
		new SlackChannel({
			botToken: "xoxb-test",
			appToken: "xapp-test",
			metrics,
		});
		fireSocketEvent("connected");
		// Simulate some time elapsing before the reconnect; the value
		// observed must be >= 0 even with a sub-millisecond gap.
		await new Promise((r) => setTimeout(r, 5));
		fireSocketEvent("reconnecting");
		const text = await registry.metrics();
		expect(readCounter(text, "phantom_slack_socket_reconnects_total")).toBe(1);
		expect(readHistogramCount(text, "phantom_slack_socket_connection_seconds")).toBe(1);
		expect(readGauge(text, "phantom_slack_socket_state", "reconnecting")).toBe(1);
	});

	test("'disconnected' after 'connected' observes connection duration", async () => {
		// Construction is the side effect under test: the SlackChannel ctor
		// attaches the lifecycle listeners and the dispatch middleware.
		new SlackChannel({
			botToken: "xoxb-test",
			appToken: "xapp-test",
			metrics,
		});
		fireSocketEvent("connected");
		await new Promise((r) => setTimeout(r, 5));
		fireSocketEvent("disconnected");
		const text = await registry.metrics();
		expect(readHistogramCount(text, "phantom_slack_socket_connection_seconds")).toBe(1);
		expect(readGauge(text, "phantom_slack_socket_state", "disconnected")).toBe(1);
	});

	test("'disconnected' without a prior 'connected' does NOT observe a duration", async () => {
		// Construction is the side effect under test: the SlackChannel ctor
		// attaches the lifecycle listeners and the dispatch middleware.
		new SlackChannel({
			botToken: "xoxb-test",
			appToken: "xapp-test",
			metrics,
		});
		// Disconnect before ever connecting (e.g. authentication fails before
		// the WSS handshake completes).
		fireSocketEvent("disconnected");
		const text = await registry.metrics();
		expect(readHistogramCount(text, "phantom_slack_socket_connection_seconds")).toBe(0);
	});

	test("the dispatch middleware times event handler completion", async () => {
		// Construction is the side effect under test: the SlackChannel ctor
		// attaches the lifecycle listeners and the dispatch middleware.
		new SlackChannel({
			botToken: "xoxb-test",
			appToken: "xapp-test",
			metrics,
		});
		// The SlackChannel registers exactly one global middleware on construction.
		expect(middlewares.length).toBe(1);
		const mw = middlewares[0];
		if (!mw) throw new Error("middleware not registered");
		await mw({
			body: { event: { type: "app_mention" } },
			next: async () => {
				await new Promise((r) => setTimeout(r, 3));
			},
		});
		const text = await registry.metrics();
		expect(readHistogramCount(text, "phantom_slack_event_dispatch_seconds", `event_type="app_mention"`)).toBe(1);
	});

	test("the dispatch middleware records 'unknown' for unclassified payloads", async () => {
		// Construction is the side effect under test: the SlackChannel ctor
		// attaches the lifecycle listeners and the dispatch middleware.
		new SlackChannel({
			botToken: "xoxb-test",
			appToken: "xapp-test",
			metrics,
		});
		const mw = middlewares[0];
		if (!mw) throw new Error("middleware not registered");
		await mw({ body: {}, next: async () => {} });
		const text = await registry.metrics();
		expect(readHistogramCount(text, "phantom_slack_event_dispatch_seconds", `event_type="unknown"`)).toBe(1);
	});

	test("the dispatch middleware still records on handler throw", async () => {
		// Construction is the side effect under test: the SlackChannel ctor
		// attaches the lifecycle listeners and the dispatch middleware.
		new SlackChannel({
			botToken: "xoxb-test",
			appToken: "xapp-test",
			metrics,
		});
		const mw = middlewares[0];
		if (!mw) throw new Error("middleware not registered");
		await expect(
			mw({
				body: { event: { type: "message" } },
				next: async () => {
					throw new Error("handler exploded");
				},
			}),
		).rejects.toThrow(/handler exploded/);
		const text = await registry.metrics();
		expect(readHistogramCount(text, "phantom_slack_event_dispatch_seconds", `event_type="message"`)).toBe(1);
	});

	test("omitting the metrics emitter falls back to NoopSlackMetrics without throwing", () => {
		// Construction must succeed even when no emitter is wired (e.g. tests
		// that exercise routing in isolation).
		expect(
			() =>
				new SlackChannel({
					botToken: "xoxb-test",
					appToken: "xapp-test",
				}),
		).not.toThrow();
	});
});
