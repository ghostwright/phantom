// Phase 10 PR 10-3: Prometheus counter for the EmailTool.
//
// Surface (architect §7.2):
//
//   `phantom_email_send_total{outcome, purpose}` (counter). One increment
//   per tool invocation, regardless of whether the underlying Resend POST
//   was attempted (denials by the local cap or recipient policy still
//   bump the counter). Outcomes are the seven `error_kind` values plus
//   `ok` (architect §6.8).
//
// The metrics module owns its own private prom-client `Registry` (matches
// `slack-metrics.ts` Phase 8a precedent in `src/channels/slack-metrics.ts`).
// `core/server.ts` merges every emitter's registry at scrape time so a
// poisoned registry from one channel cannot collide with another.
//
// Why not the slack-metrics registry: keeping registries per-emitter makes
// names self-contained, lets future channel rolls (Telegram, webhook) land
// without churn, and leaves a clean upgrade path to per-channel emitter
// reuse-checks.

import promClient, { type Counter, type Registry } from "prom-client";

/**
 * Outcome label values. Exhaustive: every tool path lands in exactly one.
 *
 *   - `ok`: Resend accepted the send (200 with id).
 *   - `recipient_denied`: address violated `PHANTOM_EMAIL_RECIPIENTS_ALLOWED`.
 *   - `rate_limited_local`: per-day soft cap hit before the Resend POST.
 *   - `key_unavailable`: metadata gateway 404/5xx/network error.
 *   - `rate_limited_resend`: Resend returned 429.
 *   - `validation_error`: Resend returned 422.
 *   - `service_down`: Resend returned 5xx.
 *   - `auth_failed`: Resend returned 401, OR the gateway rejected the
 *     fetch with 401 (operator-side bearer mis-config).
 */
export const EMAIL_SEND_OUTCOMES = [
	"ok",
	"recipient_denied",
	"rate_limited_local",
	"key_unavailable",
	"rate_limited_resend",
	"validation_error",
	"service_down",
	"auth_failed",
] as const;

export type EmailSendOutcome = (typeof EMAIL_SEND_OUTCOMES)[number];

/**
 * Public emitter interface implemented by both the production prom-client
 * emitter and a no-op for unconfigured / test paths. The split keeps the
 * EmailTool free of a direct prom-client dependency at the type level.
 */
export interface EmailMetricsEmitter {
	recordSend(outcome: EmailSendOutcome, purpose: string): void;
}

/**
 * Sanitize a `purpose` label value to bound cardinality. Resend's tag rule
 * (ASCII letters, numbers, underscores, dashes; max 256 chars) is also a
 * sane Prometheus label rule, so we share the same regex. Anything outside
 * the rule, or longer than 50 chars, becomes `"unknown"` so a misbehaving
 * agent does not blow up the time-series cardinality.
 */
const PURPOSE_LABEL_REGEX = /^[A-Za-z0-9_-]{1,50}$/;

export function sanitizePurpose(raw: string | undefined): string {
	const candidate = (raw ?? "").trim();
	if (!candidate) return "unspecified";
	if (!PURPOSE_LABEL_REGEX.test(candidate)) return "unknown";
	return candidate;
}

/**
 * Concrete prom-client emitter. Owns a `Registry`. Construction is
 * idempotent for production (one process-global instance from `index.ts`
 * boot) and per-test for unit tests (fresh registry per test case).
 */
export class EmailMetrics implements EmailMetricsEmitter {
	readonly registry: Registry;
	private readonly counter: Counter<"outcome" | "purpose">;

	constructor(registry?: Registry) {
		this.registry = registry ?? new promClient.Registry();
		this.counter = new promClient.Counter({
			name: "phantom_email_send_total",
			help: "Count of EmailTool invocations partitioned by terminal outcome and caller-supplied purpose.",
			labelNames: ["outcome", "purpose"] as const,
			registers: [this.registry],
		});

		// Initialize every outcome at zero so a Prometheus scrape during the
		// first quiet minute still emits a complete time-series matrix. This
		// matches the pattern in slack-metrics.ts.
		for (const outcome of EMAIL_SEND_OUTCOMES) {
			this.counter.inc({ outcome, purpose: "unspecified" }, 0);
		}
	}

	recordSend(outcome: EmailSendOutcome, purpose: string): void {
		const safePurpose = sanitizePurpose(purpose);
		this.counter.inc({ outcome, purpose: safePurpose }, 1);
	}
}

/**
 * No-op emitter for paths that boot without metrics (unit tests for the
 * tool, dev mode without the registry). The EmailTool calls `recordSend`
 * unconditionally so production wiring is identical; the no-op avoids a
 * `?.` at every callsite.
 */
export class NoopEmailMetrics implements EmailMetricsEmitter {
	recordSend(_outcome: EmailSendOutcome, _purpose: string): void {
		/* no-op */
	}
}
