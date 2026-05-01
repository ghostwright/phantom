// Phase 8a: Slack Socket Mode lifecycle observability.
//
// We expose four Prometheus metrics over `/metrics`:
//
//   - `phantom_slack_socket_state` (gauge, label: `state`). One time series per
//     state (`connecting`, `authenticated`, `connected`, `reconnecting`,
//     `disconnecting`, `disconnected`). At any instant exactly one series is
//     1.0; the rest are 0.0. A sustained gap in `connected=1` is the signal
//     "this tenant is offline"; alerting watches `1 - max_over_time(...)` over
//     a 1-minute window.
//   - `phantom_slack_socket_reconnects_total` (counter). Incremented every
//     time the underlying SocketModeClient emits `reconnecting`. Bolt's
//     auto-reconnect is on by default; this counter measures "the network
//     wobbled" rather than "we lost the tenant". Alerting fires when the rate
//     exceeds a per-minute threshold tuned to Slack-side hiccups (5/min is
//     sustained pain; 1-2/min is normal weather).
//   - `phantom_slack_socket_connection_seconds` (histogram). Time from
//     `connected` to the next `disconnected`, observed at disconnect. Useful
//     for the long-tail SLO: 99.9% of connections should hold for >1 hour.
//   - `phantom_slack_event_dispatch_seconds` (histogram, label: `event_type`).
//     End-to-end time from `slack_event` arrival to Bolt's `app.use`
//     middleware completion. Captures handler latency including the agent's
//     own work (LLM calls, memory writes) when triggered from Slack.
//
// The metrics emitter is intentionally per-channel. The in-VM Phantom runs
// one Slack channel; for self-hosters who eventually run multiple workspaces
// in one process we still keep per-channel emitters because the metrics
// names already disambiguate by container/host (Prometheus job + instance).
//
// Cross-repo: the prom-client default registry is NOT used. We own a
// dedicated `slackMetricsRegistry` so future shared-channel metrics (Telegram,
// email, webhook) can each own their own registry, and `core/server.ts`
// merges them at request time. This keeps a buggy second emitter from
// poisoning the global registry with name collisions.

import promClient, { type Counter, type Gauge, type Histogram, type Registry } from "prom-client";

/**
 * Lifecycle states emitted by `@slack/socket-mode`'s `SocketModeClient`.
 * Authoritative source: the `State` enum in `node_modules/@slack/socket-mode/dist/src/SocketModeClient.js`.
 * We translate `unable_to_socket_mode_start` (an unrecoverable Bolt error
 * thrown by `start()`) onto an `error` derived state for the gauge so the
 * fleet view does not silently flatline when the receiver never connects.
 */
export type SlackSocketState =
	| "connecting"
	| "authenticated"
	| "connected"
	| "reconnecting"
	| "disconnecting"
	| "disconnected"
	| "error";

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
 * Bucket layout for `phantom_slack_socket_connection_seconds`. Spans the
 * realistic range from "Slack hiccup, reconnect within seconds" to "the
 * connection held for a day". The default prom-client histogram buckets
 * (top out at 10s) are useless for a long-running WebSocket; the layout
 * here keeps p50/p99 visible at both ends.
 */
const CONNECTION_BUCKETS_SECONDS = [1, 5, 10, 30, 60, 300, 600, 1800, 3600, 21600, 86400];

/**
 * Bucket layout for `phantom_slack_event_dispatch_seconds`. Slack's ack
 * deadline is 3 seconds, so we want fine resolution under 1s and a tail
 * to catch handlers that run away (LLM calls can spike to 30s+).
 */
const EVENT_DISPATCH_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30];

/**
 * Public interface implemented by the production emitter (and by test
 * doubles in `slack-metrics.test.ts`). The split means `SlackChannel` does
 * not depend on prom-client directly; tests can substitute a recording
 * stub without spinning up a registry per test case.
 */
export interface SlackMetricsEmitter {
	/** Mark the gauge: write 1.0 for `state` and 0.0 for the others. */
	recordState(state: SlackSocketState): void;
	/** Bump the reconnect counter on every `reconnecting` event. */
	recordReconnect(): void;
	/** Observe a completed connection's lifetime in seconds. */
	observeConnectionDuration(seconds: number): void;
	/** Observe one event-handler dispatch in seconds. */
	observeEventDispatch(eventType: string, seconds: number): void;
}

/**
 * Concrete prom-client backed emitter. Owns a `Registry` so the caller can
 * expose `register.metrics()` over HTTP without touching prom-client's
 * default global registry. Construction is idempotent: calling `create`
 * twice with the same registry creates fresh metric handles each time, but
 * production uses one process-global instance from `index.ts` boot.
 */
export class SlackMetrics implements SlackMetricsEmitter {
	readonly registry: Registry;
	private readonly stateGauge: Gauge<"state">;
	private readonly reconnectsCounter: Counter<string>;
	private readonly connectionHistogram: Histogram<string>;
	private readonly eventDispatchHistogram: Histogram<"event_type">;

	constructor(registry?: Registry) {
		// Tests pass a fresh Registry per case so positive/negative assertions
		// do not leak counter state between tests. Production passes nothing
		// and gets a private registry per emitter instance.
		this.registry = registry ?? new promClient.Registry();

		this.stateGauge = new promClient.Gauge({
			name: "phantom_slack_socket_state",
			help: "Slack Socket Mode connection state. Exactly one series is 1.0 at any instant; the rest are 0.0.",
			labelNames: ["state"] as const,
			registers: [this.registry],
		});

		this.reconnectsCounter = new promClient.Counter({
			name: "phantom_slack_socket_reconnects_total",
			help: "Count of Slack Socket Mode reconnection attempts since process start.",
			registers: [this.registry],
		});

		this.connectionHistogram = new promClient.Histogram({
			name: "phantom_slack_socket_connection_seconds",
			help: "Duration of a single Slack Socket Mode connection from connect to disconnect.",
			buckets: CONNECTION_BUCKETS_SECONDS,
			registers: [this.registry],
		});

		this.eventDispatchHistogram = new promClient.Histogram({
			name: "phantom_slack_event_dispatch_seconds",
			help: "End-to-end Slack event dispatch latency from receive to handler completion.",
			labelNames: ["event_type"] as const,
			buckets: EVENT_DISPATCH_BUCKETS_SECONDS,
			registers: [this.registry],
		});

		// Initialize every state series at 0 so a Prometheus scrape during the
		// connecting window still has a complete time series matrix. Without
		// this, alerts on `slack_socket_state{state="connected"} == 0` fire
		// before the first lifecycle event lands.
		for (const s of ALL_STATES) {
			this.stateGauge.set({ state: s }, 0);
		}
	}

	recordState(state: SlackSocketState): void {
		for (const s of ALL_STATES) {
			this.stateGauge.set({ state: s }, s === state ? 1 : 0);
		}
	}

	recordReconnect(): void {
		this.reconnectsCounter.inc();
	}

	observeConnectionDuration(seconds: number): void {
		// Defensive guard: clock skew or a misuse pattern (observe() called
		// twice for the same connect window) can yield a negative value.
		// prom-client throws on negative input; we drop silently so the
		// caller does not have to care.
		if (seconds < 0 || !Number.isFinite(seconds)) return;
		this.connectionHistogram.observe(seconds);
	}

	observeEventDispatch(eventType: string, seconds: number): void {
		if (seconds < 0 || !Number.isFinite(seconds)) return;
		this.eventDispatchHistogram.observe({ event_type: eventType }, seconds);
	}
}

/**
 * No-op emitter used when metrics are disabled (e.g. tests that only care
 * about routing) or when the channel is constructed outside the boot path
 * (e.g. unit tests of egress helpers). The lifecycle hooks still call
 * `record*` so the production emitter is wired the same way; the no-op
 * avoids guarding every callsite with `?.`.
 */
export class NoopSlackMetrics implements SlackMetricsEmitter {
	recordState(_state: SlackSocketState): void {
		/* no-op */
	}
	recordReconnect(): void {
		/* no-op */
	}
	observeConnectionDuration(_seconds: number): void {
		/* no-op */
	}
	observeEventDispatch(_eventType: string, _seconds: number): void {
		/* no-op */
	}
}
