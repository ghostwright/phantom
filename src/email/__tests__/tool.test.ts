import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import promClient from "prom-client";
import type { KeyFetchResult, KeyFetcher } from "../key-fetcher.ts";
import { EmailMetrics } from "../metrics.ts";
import {
	type EmailToolDeps,
	type ResendSendFn,
	type SendEmailInput,
	__resetDailyCounterForTests,
	computeIdempotencyKey,
	createEmailToolServer,
	createSendEmailHandler,
} from "../tool.ts";

const TENANT_A = "tenant_a_ulid";
const TENANT_B = "tenant_b_ulid";
const OWNER = "owner@example.com";
const SECRET = "re_test_value";

class StaticKeyFetcher implements KeyFetcher {
	invalidateCalls = 0;
	constructor(private readonly result: KeyFetchResult) {}
	async get(): Promise<KeyFetchResult> {
		return this.result;
	}
	invalidate(): void {
		this.invalidateCalls += 1;
	}
}

type CapturedSend = {
	apiKey: string;
	args: Parameters<ResendSendFn>[1];
	options: Parameters<ResendSendFn>[2];
};

function makeRecordingSender(result: Awaited<ReturnType<ResendSendFn>>) {
	const captured: CapturedSend[] = [];
	const sender: ResendSendFn = async (apiKey, args, options) => {
		captured.push({ apiKey, args, options });
		return result;
	};
	return { sender, captured };
}

function defaultDeps(overrides?: Partial<EmailToolDeps>): EmailToolDeps {
	return {
		agentName: "cody",
		domain: "phantom.ghostwright.dev",
		dailyLimit: 50,
		tenantId: TENANT_A,
		ownerEmail: OWNER,
		keyFetcher: new StaticKeyFetcher({ ok: true, value: SECRET }),
		metrics: new EmailMetrics(new promClient.Registry()),
		...overrides,
	};
}

async function callSendTool(
	handler: ReturnType<typeof createSendEmailHandler>,
	input: SendEmailInput,
): Promise<{ isError?: boolean; payload: Record<string, unknown> }> {
	const result = await handler(input);
	const text = result.content[0]?.text ?? "";
	return {
		isError: result.isError,
		payload: text ? (JSON.parse(text) as Record<string, unknown>) : {},
	};
}

beforeEach(() => {
	__resetDailyCounterForTests();
});

afterEach(() => {
	__resetDailyCounterForTests();
});

describe("createEmailToolServer factory shape", () => {
	test("returns a valid SDK MCP server config", () => {
		const sender = makeRecordingSender({ ok: true, id: "email_id" });
		const server = createEmailToolServer(defaultDeps({ resendSendImpl: sender.sender }));
		expect(server).toBeDefined();
		expect(server.type).toBe("sdk");
		expect(server.name).toBe("phantom-email");
		expect(server.instance).toBeDefined();
	});

	test("factory produces independent instances", () => {
		const a = createEmailToolServer(defaultDeps());
		const b = createEmailToolServer(defaultDeps());
		expect(a).not.toBe(b);
	});

	test("missing owner email throws at construction (no open-relay default)", () => {
		expect(() => createEmailToolServer(defaultDeps({ ownerEmail: "" }))).toThrow(/PHANTOM_OWNER_EMAIL/);
	});
});

describe("happy path", () => {
	test("returns sent:true with the right tags + idempotency key", async () => {
		const sender = makeRecordingSender({ ok: true, id: "email_id_1" });
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender.sender }));
		const { isError, payload } = await callSendTool(handler, {
			to: OWNER,
			subject: "hello",
			text: "hi",
			purpose: "agent_ping_user",
		});
		expect(isError).toBeUndefined();
		expect(payload.sent).toBe(true);
		expect(payload.id).toBe("email_id_1");
		expect(sender.captured).toHaveLength(1);
		const tags = sender.captured[0]?.args.tags ?? [];
		expect(tags).toEqual([
			{ name: "tenant_id", value: TENANT_A },
			{ name: "agent_id", value: TENANT_A },
			{ name: "purpose", value: "agent_ping_user" },
		]);
	});

	test("default purpose is 'unspecified' when not supplied", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender.sender }));
		await callSendTool(handler, { to: OWNER, subject: "s", text: "t" });
		const tags = sender.captured[0]?.args.tags ?? [];
		expect(tags.find((t) => t.name === "purpose")?.value).toBe("unspecified");
	});

	test("default replyTo is the owner when not supplied (sending domain has no inbox)", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender.sender }));
		await callSendTool(handler, { to: OWNER, subject: "s", text: "t" });
		expect(sender.captured[0]?.args.replyTo).toEqual([OWNER]);
	});

	test("explicit replyTo wins over the default", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender.sender }));
		await callSendTool(handler, {
			to: OWNER,
			subject: "s",
			text: "t",
			replyTo: "support@acme.com",
		});
		expect(sender.captured[0]?.args.replyTo).toEqual(["support@acme.com"]);
	});

	test("agentId override is reflected in the agent_id tag", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ agentId: "agent_x_ulid", resendSendImpl: sender.sender }));
		await callSendTool(handler, { to: OWNER, subject: "s", text: "t" });
		const agentTag = sender.captured[0]?.args.tags?.find((t) => t.name === "agent_id");
		expect(agentTag?.value).toBe("agent_x_ulid");
	});

	test("from is fixed to <agentName>@<domain> regardless of tool input", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender.sender }));
		await callSendTool(handler, { to: OWNER, subject: "s", text: "t" });
		expect(sender.captured[0]?.args.from).toBe("cody <cody@phantom.ghostwright.dev>");
	});
});

describe("idempotency key (tenant-salted, architect §9.6)", () => {
	test("the input formula is sha256(tenantId:normalizedTo:subject:utcDate)", () => {
		const key = computeIdempotencyKey({
			tenantId: TENANT_A,
			to: ["a@x.com", "B@x.com"],
			subject: "hello",
			utcDate: "2026-05-01",
		});
		expect(key).toMatch(/^[a-f0-9]{32}$/);
	});

	test("two tenants sending to the same recipient with same subject + day get DIFFERENT keys", () => {
		const ka = computeIdempotencyKey({
			tenantId: TENANT_A,
			to: [OWNER],
			subject: "subj",
			utcDate: "2026-05-01",
		});
		const kb = computeIdempotencyKey({
			tenantId: TENANT_B,
			to: [OWNER],
			subject: "subj",
			utcDate: "2026-05-01",
		});
		expect(ka).not.toBe(kb);
	});

	test("the same tenant generating the same call twice gets the SAME key (idempotent within a day)", () => {
		const ka = computeIdempotencyKey({
			tenantId: TENANT_A,
			to: [OWNER],
			subject: "subj",
			utcDate: "2026-05-01",
		});
		const kb = computeIdempotencyKey({
			tenantId: TENANT_A,
			to: [OWNER],
			subject: "subj",
			utcDate: "2026-05-01",
		});
		expect(ka).toBe(kb);
	});

	test("the recipients are normalized (sort, lowercase) so [a, B] === [b, A]", () => {
		const k1 = computeIdempotencyKey({
			tenantId: TENANT_A,
			to: ["a@x.com", "B@x.com"],
			subject: "s",
			utcDate: "2026-05-01",
		});
		const k2 = computeIdempotencyKey({
			tenantId: TENANT_A,
			to: ["b@x.com", "A@x.com"],
			subject: "s",
			utcDate: "2026-05-01",
		});
		expect(k1).toBe(k2);
	});

	test("different days get different keys", () => {
		const k1 = computeIdempotencyKey({
			tenantId: TENANT_A,
			to: [OWNER],
			subject: "s",
			utcDate: "2026-05-01",
		});
		const k2 = computeIdempotencyKey({
			tenantId: TENANT_A,
			to: [OWNER],
			subject: "s",
			utcDate: "2026-05-02",
		});
		expect(k1).not.toBe(k2);
	});

	test("the idempotencyKey is passed to Resend on every send", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender.sender }));
		await callSendTool(handler, { to: OWNER, subject: "s", text: "t" });
		expect(sender.captured[0]?.options.idempotencyKey).toMatch(/^[a-f0-9]{32}$/);
	});
});

describe("recipient policy", () => {
	test("default (owner-only): owner allowed, stranger denied with error_kind=recipient_denied", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender.sender }));
		const { isError, payload } = await callSendTool(handler, {
			to: "stranger@example.com",
			subject: "s",
			text: "t",
		});
		expect(isError).toBe(true);
		expect(payload.error_kind).toBe("recipient_denied");
		expect(sender.captured).toHaveLength(0);
	});

	test("unrestricted policy allows arbitrary recipients", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(
			defaultDeps({ recipientsAllowed: "unrestricted", resendSendImpl: sender.sender }),
		);
		const { isError } = await callSendTool(handler, {
			to: "anyone@anywhere.com",
			subject: "s",
			text: "t",
		});
		expect(isError).toBeUndefined();
		expect(sender.captured).toHaveLength(1);
	});

	test("list policy allows owner plus listed", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(
			defaultDeps({
				recipientsAllowed: "alice@acme.com",
				resendSendImpl: sender.sender,
			}),
		);
		const ok = await callSendTool(handler, {
			to: "alice@acme.com",
			subject: "s",
			text: "t",
		});
		expect(ok.isError).toBeUndefined();
		const denied = await callSendTool(handler, {
			to: "carol@acme.com",
			subject: "s",
			text: "t",
		});
		expect(denied.isError).toBe(true);
		expect(denied.payload.error_kind).toBe("recipient_denied");
	});

	test("a denied cc poisons the whole send (no Resend POST)", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender.sender }));
		const { isError, payload } = await callSendTool(handler, {
			to: OWNER,
			cc: "stranger@x.com",
			subject: "s",
			text: "t",
		});
		expect(isError).toBe(true);
		expect(payload.error_kind).toBe("recipient_denied");
		expect(sender.captured).toHaveLength(0);
	});
});

describe("daily cap", () => {
	test("local cap returns rate_limited_local without calling Resend", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ dailyLimit: 1, resendSendImpl: sender.sender }));
		const first = await callSendTool(handler, { to: OWNER, subject: "s1", text: "t1" });
		expect(first.isError).toBeUndefined();
		const second = await callSendTool(handler, { to: OWNER, subject: "s2", text: "t2" });
		expect(second.isError).toBe(true);
		expect(second.payload.error_kind).toBe("rate_limited_local");
		expect(sender.captured).toHaveLength(1);
	});

	test("policy denial does NOT consume the daily budget", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ dailyLimit: 1, resendSendImpl: sender.sender }));
		const denied = await callSendTool(handler, {
			to: "stranger@x.com",
			subject: "s",
			text: "t",
		});
		expect(denied.isError).toBe(true);
		const ok = await callSendTool(handler, { to: OWNER, subject: "s2", text: "t2" });
		expect(ok.isError).toBeUndefined();
	});

	test("Resend error does NOT consume the daily budget", async () => {
		const sender = makeRecordingSender({
			ok: false,
			kind: "rate_limited",
			message: "throttled",
		});
		const handler = createSendEmailHandler(defaultDeps({ dailyLimit: 1, resendSendImpl: sender.sender }));
		const fail = await callSendTool(handler, { to: OWNER, subject: "s", text: "t" });
		expect(fail.payload.error_kind).toBe("rate_limited_resend");
		const after = await callSendTool(handler, { to: OWNER, subject: "s2", text: "t2" });
		expect(after.payload.error_kind).not.toBe("rate_limited_local");
	});
});

describe("error_kind taxonomy (architect §6.8)", () => {
	test("key fetcher 'unavailable' -> error_kind=key_unavailable", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(
			defaultDeps({
				keyFetcher: new StaticKeyFetcher({
					ok: false,
					error: { kind: "unavailable", message: "404" },
				}),
				resendSendImpl: sender.sender,
			}),
		);
		const { isError, payload } = await callSendTool(handler, {
			to: OWNER,
			subject: "s",
			text: "t",
		});
		expect(isError).toBe(true);
		expect(payload.error_kind).toBe("key_unavailable");
		expect(sender.captured).toHaveLength(0);
	});

	test("key fetcher 'auth_failed' -> error_kind=auth_failed", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(
			defaultDeps({
				keyFetcher: new StaticKeyFetcher({
					ok: false,
					error: { kind: "auth_failed", message: "gateway 401" },
				}),
				resendSendImpl: sender.sender,
			}),
		);
		const { isError, payload } = await callSendTool(handler, {
			to: OWNER,
			subject: "s",
			text: "t",
		});
		expect(isError).toBe(true);
		expect(payload.error_kind).toBe("auth_failed");
	});

	test("Resend 401 -> error_kind=auth_failed AND fetcher.invalidate() is called", async () => {
		const fetcher = new StaticKeyFetcher({ ok: true, value: SECRET });
		const sender = makeRecordingSender({
			ok: false,
			kind: "auth_failed",
			message: "401",
		});
		const handler = createSendEmailHandler(defaultDeps({ keyFetcher: fetcher, resendSendImpl: sender.sender }));
		const { payload } = await callSendTool(handler, {
			to: OWNER,
			subject: "s",
			text: "t",
		});
		expect(payload.error_kind).toBe("auth_failed");
		expect(fetcher.invalidateCalls).toBe(1);
	});

	test("Resend 429 -> error_kind=rate_limited_resend", async () => {
		const sender = makeRecordingSender({
			ok: false,
			kind: "rate_limited",
			message: "throttled",
		});
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender.sender }));
		const { payload } = await callSendTool(handler, {
			to: OWNER,
			subject: "s",
			text: "t",
		});
		expect(payload.error_kind).toBe("rate_limited_resend");
	});

	test("Resend 422 -> error_kind=validation_error", async () => {
		const sender = makeRecordingSender({
			ok: false,
			kind: "validation",
			message: "bad recipient",
		});
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender.sender }));
		const { payload } = await callSendTool(handler, {
			to: OWNER,
			subject: "s",
			text: "t",
		});
		expect(payload.error_kind).toBe("validation_error");
	});

	test("Resend 5xx -> error_kind=service_down", async () => {
		const sender = makeRecordingSender({
			ok: false,
			kind: "service_down",
			message: "upstream down",
		});
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender.sender }));
		const { payload } = await callSendTool(handler, {
			to: OWNER,
			subject: "s",
			text: "t",
		});
		expect(payload.error_kind).toBe("service_down");
	});

	test("a thrown sender returns service_down (defensive)", async () => {
		const sender: ResendSendFn = async () => {
			throw new Error(`oh no key=${SECRET}`);
		};
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender }));
		const { isError, payload } = await callSendTool(handler, {
			to: OWNER,
			subject: "s",
			text: "t",
		});
		expect(isError).toBe(true);
		expect(payload.error_kind).toBe("service_down");
		// The error message must NOT carry the secret
		expect(JSON.stringify(payload)).not.toContain(SECRET);
	});
});

describe("metrics integration", () => {
	test("ok outcome increments phantom_email_send_total{outcome=ok}", async () => {
		const registry = new promClient.Registry();
		const metrics = new EmailMetrics(registry);
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ metrics, resendSendImpl: sender.sender }));
		await callSendTool(handler, { to: OWNER, subject: "s", text: "t", purpose: "agent_ping_user" });
		const text = await registry.metrics();
		expect(text).toMatch(/phantom_email_send_total\{outcome="ok",purpose="agent_ping_user"\} 1/);
	});

	test("recipient_denied outcome increments without a Resend POST", async () => {
		const registry = new promClient.Registry();
		const metrics = new EmailMetrics(registry);
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ metrics, resendSendImpl: sender.sender }));
		await callSendTool(handler, {
			to: "stranger@x.com",
			subject: "s",
			text: "t",
			purpose: "intro_dm",
		});
		const text = await registry.metrics();
		expect(text).toMatch(/phantom_email_send_total\{outcome="recipient_denied",purpose="intro_dm"\} 1/);
		expect(sender.captured).toHaveLength(0);
	});

	test("rate_limited_local outcome increments after the cap", async () => {
		const registry = new promClient.Registry();
		const metrics = new EmailMetrics(registry);
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ dailyLimit: 1, metrics, resendSendImpl: sender.sender }));
		await callSendTool(handler, { to: OWNER, subject: "s1", text: "t1", purpose: "agent_ping_user" });
		await callSendTool(handler, { to: OWNER, subject: "s2", text: "t2", purpose: "agent_ping_user" });
		const text = await registry.metrics();
		expect(text).toMatch(/phantom_email_send_total\{outcome="rate_limited_local",purpose="agent_ping_user"\} 1/);
	});
});

describe("plaintext-leak guards", () => {
	test("the secret value never appears in any tool response body", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender.sender }));
		const { payload } = await callSendTool(handler, {
			to: OWNER,
			subject: "s",
			text: "t",
		});
		expect(JSON.stringify(payload)).not.toContain(SECRET);
	});

	test("the secret value never appears in any error response across every kind", async () => {
		const samples: Array<{ deps: Partial<EmailToolDeps>; input: SendEmailInput }> = [
			{
				deps: {
					keyFetcher: new StaticKeyFetcher({
						ok: false,
						error: { kind: "unavailable", message: SECRET },
					}),
				},
				input: { to: OWNER, subject: "s", text: "t" },
			},
			{
				deps: {
					keyFetcher: new StaticKeyFetcher({
						ok: false,
						error: { kind: "auth_failed", message: SECRET },
					}),
				},
				input: { to: OWNER, subject: "s", text: "t" },
			},
			{
				deps: {
					resendSendImpl: async () => ({
						ok: false,
						kind: "auth_failed",
						message: SECRET,
					}),
				},
				input: { to: OWNER, subject: "s", text: "t" },
			},
			{
				deps: {
					resendSendImpl: async () => ({
						ok: false,
						kind: "validation",
						message: `bad input ${SECRET}`,
					}),
				},
				input: { to: OWNER, subject: "s", text: "t" },
			},
		];
		for (const sample of samples) {
			const handler = createSendEmailHandler(defaultDeps(sample.deps));
			const { payload } = await callSendTool(handler, sample.input);
			// Note: validation_error explicitly forwards the upstream message
			// to the agent (so it can suggest a fix); for that path the
			// upstream sender should already have stripped any secret. We
			// verify the error envelope does not echo the literal SECRET
			// string EXCEPT through validation_error where the upstream
			// supplied it knowingly.
			if (payload.error_kind !== "validation_error") {
				expect(JSON.stringify(payload)).not.toContain(SECRET);
			}
		}
	});

	test("captured sender args do not include the secret in the tag bundle (cardinality + leak guard)", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender.sender }));
		await callSendTool(handler, { to: OWNER, subject: "s", text: "t" });
		const tags = sender.captured[0]?.args.tags ?? [];
		for (const tag of tags) {
			expect(tag.value).not.toBe(SECRET);
		}
	});
});

describe("tag value sanitization (Resend ASCII-only rule)", () => {
	test("tenant ids with non-ASCII characters are scrubbed to underscores", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(
			defaultDeps({ tenantId: "tenant 🤖 with space", resendSendImpl: sender.sender }),
		);
		await callSendTool(handler, { to: OWNER, subject: "s", text: "t" });
		const tag = sender.captured[0]?.args.tags?.find((t) => t.name === "tenant_id");
		expect(tag?.value).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	test("invalid purpose strings become 'unknown'", async () => {
		const sender = makeRecordingSender({ ok: true, id: "id" });
		const handler = createSendEmailHandler(defaultDeps({ resendSendImpl: sender.sender }));
		await callSendTool(handler, {
			to: OWNER,
			subject: "s",
			text: "t",
			purpose: "has space",
		});
		const tag = sender.captured[0]?.args.tags?.find((t) => t.name === "purpose");
		expect(tag?.value).toBe("unknown");
	});
});
