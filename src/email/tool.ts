// Phase 10 PR 10-3: in-VM Phantom EmailTool. Sends transactional email via
// Resend, on the operator's API key, with cost-attribution tags + a
// tenant-salted idempotency key + a recipient-policy gate + a Prometheus
// counter.
//
// The architect doc at
// `phantom-cloud-deploy/local/2026-05-01-phase10-resend-architect.md`
// is the canonical contract (§6 EmailTool surface, §6.8 seven `error_kind`
// values, §9.6 tenant-salted idempotency, §7 cost attribution).
//
// Design summary:
//
//   - Key source. The Resend API key is fetched from the metadata gateway
//     at every call (with a 15-minute cache) instead of read from
//     `process.env.RESEND_API_KEY`. Storage is in phantomd's KMS-sealed
//     `tenant_secrets` table, seeded by phantom-control's chainSeedResendKey
//     step (Phase 10 PR 10-2). Rotation is fleet-instant via PR 10-5's
//     admin RPC; the cache TTL bounds the propagation window at 15 min.
//   - Recipient policy. A per-tenant gate (PHANTOM_OWNER_EMAIL plus
//     PHANTOM_EMAIL_RECIPIENTS_ALLOWED) decides whether the agent can email
//     a given address. Default is owner-only. Operators can opt-in to a
//     fixed allowlist or full-open via the env. Denial returns
//     `error_kind = "recipient_denied"` without ever calling Resend.
//   - Tags. Every Resend POST carries `tenant_id`, `agent_id`, and
//     `purpose` tags so the operator can pull cost-per-tenant from Resend's
//     dashboard.
//   - Idempotency. The key is sha256-derived from
//     `${tenantId}:${normalizedTo}:${subject}:${utcDate}` so a same-tenant
//     same-recipient same-subject-same-day retry dedupes at Resend, while
//     different tenants generating the same logical email get DIFFERENT
//     keys (defends Resend's TEAM-scoped key namespace from cross-tenant
//     collision; architect §9.6).
//   - Metrics. Every tool call increments
//     `phantom_email_send_total{outcome, purpose}` regardless of whether
//     Resend was reached.
//
// Plaintext-leak guards:
//   - The Resend API key is never logged.
//   - The cached value lives in the fetcher; the tool reads it once per
//     send and never echoes it via `console.*` or in the response.
//   - Errors returned to the agent contain only the kind plus a
//     human-friendly message; no upstream HTTP body, no stack trace text
//     that could embed the key.

import { createHash } from "node:crypto";
import { z } from "zod";
import { type McpSdkServerConfigWithInstance, createSdkMcpServer, tool } from "../agent/agent-sdk.ts";
import { type KeyFetcher, ResendKeyFetcher } from "./key-fetcher.ts";
import { type EmailMetricsEmitter, NoopEmailMetrics, sanitizePurpose } from "./metrics.ts";
import { type RecipientPolicy, checkRecipients, parseRecipientPolicy } from "./recipient-policy.ts";

export const EMAIL_ERROR_KINDS = [
	"recipient_denied",
	"rate_limited_local",
	"key_unavailable",
	"rate_limited_resend",
	"validation_error",
	"service_down",
	"auth_failed",
] as const;
export type EmailErrorKind = (typeof EMAIL_ERROR_KINDS)[number];

export type EmailToolDeps = {
	agentName: string;
	domain: string;
	dailyLimit: number;
	tenantId: string;
	agentId?: string;
	ownerEmail: string;
	recipientsAllowed?: string;
	keyFetcher?: KeyFetcher;
	metrics?: EmailMetricsEmitter;
	/**
	 * Resend SDK injection seam for tests. Production omits this and the
	 * tool lazy-imports the real SDK (so the package never loads when the
	 * key is absent).
	 */
	resendSendImpl?: ResendSendFn;
};

type ResendTag = { name: string; value: string };

type ResendSendArgs = {
	from: string;
	to: string[];
	subject: string;
	text: string;
	html?: string;
	cc?: string[];
	bcc?: string[];
	replyTo?: string[];
	tags: ResendTag[];
};

type ResendSendOptions = { idempotencyKey: string };

type ResendSendOk = { ok: true; id: string };
type ResendSendErrKind = "rate_limited" | "validation" | "service_down" | "auth_failed";
type ResendSendErr = { ok: false; kind: ResendSendErrKind; message: string };
export type ResendSendResult = ResendSendOk | ResendSendErr;
export type ResendSendFn = (
	apiKey: string,
	args: ResendSendArgs,
	options: ResendSendOptions,
) => Promise<ResendSendResult>;

type DailyCounter = {
	sent: number;
	dateKey: string;
};

const dailyCounter: DailyCounter = {
	sent: 0,
	dateKey: new Date().toDateString(),
};

function checkDailyLimit(limit: number): { allowed: boolean; remaining: number } {
	const today = new Date().toDateString();
	if (today !== dailyCounter.dateKey) {
		dailyCounter.sent = 0;
		dailyCounter.dateKey = today;
	}
	return {
		allowed: dailyCounter.sent < limit,
		remaining: Math.max(0, limit - dailyCounter.sent),
	};
}

function bumpDailyLimit(): void {
	dailyCounter.sent += 1;
}

/** Reset the in-process daily counter. Test-only. */
export function __resetDailyCounterForTests(): void {
	dailyCounter.sent = 0;
	dailyCounter.dateKey = new Date().toDateString();
}

function ok(data: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string, kind: EmailErrorKind): { content: Array<{ type: "text"; text: string }>; isError: true } {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: message, error_kind: kind }) }],
		isError: true,
	};
}

function utcDateISO(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * Sha256 of `${tenantId}:${normalizedTo}:${subject}:${utcDate}`. The salt
 * defends Resend's TEAM-scoped idempotency-key namespace from cross-tenant
 * collision (architect §9.6). The same tenant sending the same logical
 * email on the same UTC day gets the same key (Resend dedupes). Different
 * tenants always produce different keys.
 *
 * Resend caps the idempotency key at 256 chars; we slice 32 hex chars
 * (128 bits, more than enough collision resistance).
 */
export function computeIdempotencyKey(input: {
	tenantId: string;
	to: string[];
	subject: string;
	utcDate?: string;
}): string {
	const sortedTo = [...input.to]
		.map((s) => s.trim().toLowerCase())
		.sort()
		.join(",");
	const date = input.utcDate ?? utcDateISO();
	const material = `${input.tenantId}:${sortedTo}:${input.subject}:${date}`;
	return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/**
 * Tag values must be ASCII only (Resend `/emails/send` rule, max 256
 * chars; letters, numbers, underscores, dashes). We sanitize aggressively
 * to keep the Resend POST from rejecting on a bad tenant_id (any char
 * outside the rule becomes `_`). Empty becomes `unknown`.
 */
function sanitizeTagValue(raw: string | undefined): string {
	const candidate = (raw ?? "").trim();
	if (!candidate) return "unknown";
	const cleaned = candidate.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
	return cleaned || "unknown";
}

export type SendEmailInput = {
	to: string | string[];
	subject: string;
	text: string;
	html?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | string[];
	purpose?: string;
};

export type SendEmailToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
};

export type SendEmailHandler = (input: SendEmailInput) => Promise<SendEmailToolResult>;

/**
 * Create the underlying handler function. Exposed for unit tests so the test
 * surface does not depend on poking at the MCP SDK's private
 * `_registeredTools` map. Production builds also use this function; the
 * `createEmailToolServer` factory wraps it with the SDK `tool()` registration.
 */
export function createSendEmailHandler(deps: EmailToolDeps): SendEmailHandler {
	const fromAddress = `${deps.agentName}@${deps.domain}`;
	const fromHeader = `${deps.agentName} <${fromAddress}>`;
	const policy: RecipientPolicy = parseRecipientPolicy({
		ownerEmail: deps.ownerEmail,
		recipientsAllowed: deps.recipientsAllowed,
	});
	const keyFetcher = deps.keyFetcher ?? new ResendKeyFetcher();
	const metrics: EmailMetricsEmitter = deps.metrics ?? new NoopEmailMetrics();
	const resendSend = deps.resendSendImpl ?? defaultResendSend;
	const safeTenantId = sanitizeTagValue(deps.tenantId);
	const safeAgentId = sanitizeTagValue(deps.agentId ?? deps.tenantId);

	return async (input: SendEmailInput): Promise<SendEmailToolResult> => {
		const purpose = sanitizePurpose(input.purpose);
		const toList = Array.isArray(input.to) ? input.to : [input.to];
		const ccList = input.cc ? (Array.isArray(input.cc) ? input.cc : [input.cc]) : undefined;
		const bccList = input.bcc ? (Array.isArray(input.bcc) ? input.bcc : [input.bcc]) : undefined;
		const replyToList = input.replyTo
			? Array.isArray(input.replyTo)
				? input.replyTo
				: [input.replyTo]
			: [policy.ownerEmail];

		// 1) Daily local cap. Surfaced before any network/policy work so a
		// runaway agent stops cheaply.
		const rate = checkDailyLimit(deps.dailyLimit);
		if (!rate.allowed) {
			metrics.recordSend("rate_limited_local", purpose);
			return err(`Daily email limit reached (${deps.dailyLimit}). Resets at midnight.`, "rate_limited_local");
		}

		// 2) Recipient policy. Denials never reach Resend.
		const policyDecision = checkRecipients(policy, { to: toList, cc: ccList, bcc: bccList });
		if (!policyDecision.allowed) {
			metrics.recordSend("recipient_denied", purpose);
			return err(`recipient not allowed: ${policyDecision.deniedAddress}`, "recipient_denied");
		}

		// 3) Fetch the Resend key. Cached for 15 minutes; refetches on
		// cache miss / expiry. Returns structured error kinds.
		const fetchResult = await keyFetcher.get();
		if (!fetchResult.ok) {
			const kind: EmailErrorKind = fetchResult.error.kind === "auth_failed" ? "auth_failed" : "key_unavailable";
			metrics.recordSend(kind, purpose);
			const message =
				kind === "auth_failed"
					? "Email authentication failed; the operator may need to re-seed the Resend key."
					: "Email service is temporarily unavailable; try again in a minute.";
			return err(message, kind);
		}
		const apiKey = fetchResult.value;

		// 4) Compose the Resend POST.
		const idempotencyKey = computeIdempotencyKey({
			tenantId: deps.tenantId,
			to: toList,
			subject: input.subject,
		});
		const sendArgs: ResendSendArgs = {
			from: fromHeader,
			to: toList,
			subject: input.subject,
			text: input.text,
			html: input.html,
			cc: ccList,
			bcc: bccList,
			replyTo: replyToList,
			tags: [
				{ name: "tenant_id", value: safeTenantId },
				{ name: "agent_id", value: safeAgentId },
				{ name: "purpose", value: purpose },
			],
		};

		let result: ResendSendResult;
		try {
			result = await resendSend(apiKey, sendArgs, { idempotencyKey });
		} catch {
			metrics.recordSend("service_down", purpose);
			return err("Email service is having trouble; try later.", "service_down");
		}

		if (!result.ok) {
			if (result.kind === "auth_failed") {
				keyFetcher.invalidate();
				metrics.recordSend("auth_failed", purpose);
				return err("Email authentication failed; the operator may need to re-seed the Resend key.", "auth_failed");
			}
			if (result.kind === "rate_limited") {
				metrics.recordSend("rate_limited_resend", purpose);
				return err("Resend rate limit reached; try again in a minute.", "rate_limited_resend");
			}
			if (result.kind === "validation") {
				metrics.recordSend("validation_error", purpose);
				return err(`Resend rejected the request as invalid: ${result.message}`, "validation_error");
			}
			metrics.recordSend("service_down", purpose);
			return err("Resend is having issues; try later.", "service_down");
		}

		bumpDailyLimit();
		metrics.recordSend("ok", purpose);
		return ok({
			sent: true,
			id: result.id,
			from: fromAddress,
			to: toList,
			subject: input.subject,
			remaining: Math.max(0, deps.dailyLimit - dailyCounter.sent),
		});
	};
}

export function createEmailToolServer(deps: EmailToolDeps): McpSdkServerConfigWithInstance {
	const fromAddress = `${deps.agentName}@${deps.domain}`;
	const handler = createSendEmailHandler(deps);

	const sendEmailTool = tool(
		"phantom_send_email",
		`Send an email from ${fromAddress}. Use this to send reports, summaries, notifications, intro DMs, or any email to your owner or other allowlisted recipients. The from address is fixed to your agent identity. Tag the send with \`purpose\` so the operator can see why this email shipped (default \`unspecified\` works but is opaque). Rate limit: ${deps.dailyLimit} emails per day per agent (local cap; Resend's per-team rate limit is also enforced).`,
		{
			to: z
				.union([z.string().email(), z.array(z.string().email()).max(50)])
				.describe("Recipient email address(es). Max 50 in a single send."),
			subject: z.string().min(1).max(998).describe("Email subject line. Under 998 chars per RFC 5322."),
			text: z.string().min(1).describe("Plain text body of the email. Required."),
			html: z.string().optional().describe("Optional HTML body. If omitted, plain text is used."),
			cc: z
				.union([z.string().email(), z.array(z.string().email()).max(50)])
				.optional()
				.describe("CC recipients."),
			bcc: z
				.union([z.string().email(), z.array(z.string().email()).max(50)])
				.optional()
				.describe("BCC recipients."),
			replyTo: z
				.union([z.string().email(), z.array(z.string().email())])
				.optional()
				.describe("Reply-to address(es). Defaults to your owner so recipient replies land where they should."),
			purpose: z
				.string()
				.min(1)
				.max(50)
				.optional()
				.describe(
					"Why you are sending this email. Used for cost attribution. Examples: 'agent_ping_user', 'intro_dm', 'daily_summary', 'completed_task_report'. ASCII letters, numbers, underscores, dashes only.",
				),
		},
		async (input) => handler(input as SendEmailInput),
	);

	return createSdkMcpServer({
		name: "phantom-email",
		tools: [sendEmailTool],
	});
}

/**
 * Default Resend sender. Lazy-imports the SDK so dev mode without the key
 * never loads the package. Maps Resend's `error.name` onto the
 * `ResendSendErrKind` union.
 */
async function defaultResendSend(
	apiKey: string,
	args: ResendSendArgs,
	options: ResendSendOptions,
): Promise<ResendSendResult> {
	let resendModule: typeof import("resend");
	try {
		resendModule = await import("resend");
	} catch (importErr) {
		const msg = importErr instanceof Error ? importErr.message : String(importErr);
		return { ok: false, kind: "service_down", message: `resend SDK not installed: ${msg}` };
	}

	const client = new resendModule.Resend(apiKey);
	let response: Awaited<ReturnType<typeof client.emails.send>>;
	try {
		response = await client.emails.send(
			{
				from: args.from,
				to: args.to,
				subject: args.subject,
				text: args.text,
				html: args.html,
				cc: args.cc,
				bcc: args.bcc,
				replyTo: args.replyTo,
				tags: args.tags,
			},
			{ idempotencyKey: options.idempotencyKey },
		);
	} catch {
		// Network or unexpected SDK error. Treat as service_down; do NOT
		// surface the original message (it can include URL fragments that
		// embed credentials in some HTTP-client error formats).
		return { ok: false, kind: "service_down", message: "resend send threw" };
	}

	if (response.error) {
		return { ok: false, ...mapResendError(response.error) };
	}
	const id = response.data?.id;
	if (!id) {
		return { ok: false, kind: "service_down", message: "resend returned no id" };
	}
	return { ok: true, id };
}

type ResendErrorLike = { name?: string | null; message?: string | null; statusCode?: number | null };

function mapResendError(error: ResendErrorLike): { kind: ResendSendErrKind; message: string } {
	const status = typeof error.statusCode === "number" ? error.statusCode : undefined;
	const name = (error.name ?? "").toString().toLowerCase();
	const message = error.message ?? "resend error";

	if (status === 401 || name.includes("api_key")) {
		return { kind: "auth_failed", message };
	}
	if (status === 429 || name.includes("rate_limit")) {
		return { kind: "rate_limited", message };
	}
	if (status === 422 || status === 400 || name.includes("validation") || name.includes("invalid")) {
		return { kind: "validation", message };
	}
	if (status !== undefined && status >= 500 && status < 600) {
		return { kind: "service_down", message };
	}
	return { kind: "service_down", message };
}
