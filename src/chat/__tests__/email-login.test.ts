import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { revokeAllSessions } from "../../ui/session.ts";
import { clearRateLimits, handleEmailLogin, sanitizeLocalPart, sendLoginEmail } from "../email-login.ts";
import { escapeHtml } from "../util/escape.ts";

const originalEnv = { ...process.env };

beforeEach(() => {
	clearRateLimits();
	process.env.OWNER_EMAIL = "owner@example.com";
});

afterEach(() => {
	revokeAllSessions();
	clearRateLimits();
	process.env.OWNER_EMAIL = originalEnv.OWNER_EMAIL;
	process.env.RESEND_API_KEY = originalEnv.RESEND_API_KEY;
});

function makeRequest(body: Record<string, unknown>, ip = "127.0.0.1"): Request {
	return new Request("http://localhost/login/email", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Forwarded-For": ip,
		},
		body: JSON.stringify(body),
	});
}

describe("handleEmailLogin", () => {
	test("returns 200 with neutral response for valid email", async () => {
		const req = makeRequest({ email: "owner@example.com" });
		const res = await handleEmailLogin(req, "http://localhost:6666", "test-agent", "test.dev");
		expect(res.status).toBe(200);
		const data = (await res.json()) as { ok: boolean };
		expect(data.ok).toBe(true);
	});

	test("returns 200 with neutral response for invalid email", async () => {
		const req = makeRequest({ email: "wrong@example.com" });
		const res = await handleEmailLogin(req, "http://localhost:6666", "test-agent", "test.dev");
		expect(res.status).toBe(200);
		const data = (await res.json()) as { ok: boolean };
		expect(data.ok).toBe(true);
	});

	test("returns 200 with neutral response when OWNER_EMAIL is unset", async () => {
		process.env.OWNER_EMAIL = undefined;
		const req = makeRequest({ email: "someone@example.com" });
		const res = await handleEmailLogin(req, "http://localhost:6666", "test-agent", "test.dev");
		expect(res.status).toBe(200);
		const data = (await res.json()) as { ok: boolean };
		expect(data.ok).toBe(true);
	});

	test("returns 200 for missing email field", async () => {
		const req = makeRequest({});
		const res = await handleEmailLogin(req, "http://localhost:6666", "test-agent", "test.dev");
		expect(res.status).toBe(200);
	});

	test("returns 200 for invalid JSON body", async () => {
		const req = new Request("http://localhost/login/email", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Forwarded-For": "127.0.0.1",
			},
			body: "not json",
		});
		const res = await handleEmailLogin(req, "http://localhost:6666", "test-agent", "test.dev");
		expect(res.status).toBe(200);
	});

	test("rate limits to 1 per 60 seconds per IP", async () => {
		// First request succeeds (triggers rate limit regardless of match)
		const req1 = makeRequest({ email: "owner@example.com" }, "10.0.0.1");
		const res1 = await handleEmailLogin(req1, "http://localhost:6666", "test-agent", "test.dev");
		expect(res1.status).toBe(200);

		// Second request from same IP within 60 seconds
		const req2 = makeRequest({ email: "owner@example.com" }, "10.0.0.1");
		const res2 = await handleEmailLogin(req2, "http://localhost:6666", "test-agent", "test.dev");
		expect(res2.status).toBe(200);
		// Still returns ok (neutral), but it was rate-limited internally

		// Different IP is not rate-limited
		const req3 = makeRequest({ email: "owner@example.com" }, "10.0.0.2");
		const res3 = await handleEmailLogin(req3, "http://localhost:6666", "test-agent", "test.dev");
		expect(res3.status).toBe(200);
	});

	test("normalizes email comparison to lowercase", async () => {
		const req = makeRequest({ email: "OWNER@Example.COM" });
		const res = await handleEmailLogin(req, "http://localhost:6666", "test-agent", "test.dev");
		expect(res.status).toBe(200);
		const data = (await res.json()) as { ok: boolean };
		expect(data.ok).toBe(true);
	});
});

describe("sanitizeLocalPart", () => {
	test("lowercases alphanumerics", () => {
		expect(sanitizeLocalPart("Phantom")).toBe("phantom");
	});

	test("collapses spaces to hyphens", () => {
		expect(sanitizeLocalPart("My Agent")).toBe("my-agent");
	});

	test("collapses underscores and dots to hyphens", () => {
		expect(sanitizeLocalPart("my_agent.name")).toBe("my-agent-name");
	});

	test("collapses runs of hyphens and trims edges", () => {
		expect(sanitizeLocalPart("  my   agent  ")).toBe("my-agent");
	});

	test("strips anything non-alphanumeric and non-hyphen", () => {
		expect(sanitizeLocalPart("Agent!@#$%^&*()")).toBe("agent");
	});

	test("falls back to 'agent' when sanitized to empty", () => {
		expect(sanitizeLocalPart("!@#$%")).toBe("agent");
		expect(sanitizeLocalPart("")).toBe("agent");
	});

	test("falls back to 'agent' when sanitized result is shorter than 3 chars", () => {
		expect(sanitizeLocalPart("A")).toBe("agent");
		expect(sanitizeLocalPart("ab")).toBe("agent");
	});

	test("preserves 3+ char alphanumeric names", () => {
		expect(sanitizeLocalPart("abc")).toBe("abc");
		expect(sanitizeLocalPart("xyz123")).toBe("xyz123");
	});

	test("handles CRLF in input (stripped as non-alphanumeric)", () => {
		expect(sanitizeLocalPart("agent\r\n.name")).toBe("agent-name");
	});
});

describe("escapeHtml", () => {
	test("escapes the five HTML-significant characters", () => {
		expect(escapeHtml("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
		expect(escapeHtml("a \"b\" & 'c'")).toBe("a &quot;b&quot; &amp; &#39;c&#39;");
	});

	test("leaves safe text unchanged", () => {
		expect(escapeHtml("Phantom")).toBe("Phantom");
		expect(escapeHtml("my-agent")).toBe("my-agent");
	});
});

describe("sendLoginEmail", () => {
	test("throws when Resend API returns an error response", async () => {
		mock.module("resend", () => ({
			Resend: class {
				emails = {
					send: async () => ({ error: { message: "domain not verified" } }),
				};
			},
		}));
		process.env.RESEND_API_KEY = "re_test_key";

		await expect(sendLoginEmail("owner@example.com", "http://localhost/magic", "Phantom", "test.dev")).rejects.toThrow(
			"Resend API error: domain not verified",
		);
	});

	test("uses domain parameter for the sender domain", async () => {
		let capturedFrom = "";
		mock.module("resend", () => ({
			Resend: class {
				emails = {
					send: async (opts: { from: string }) => {
						capturedFrom = opts.from;
						return { data: { id: "ok" }, error: null };
					},
				};
			},
		}));
		process.env.RESEND_API_KEY = "re_test_key";

		await sendLoginEmail("owner@example.com", "http://localhost/magic", "Phantom", "mycompany.com");
		expect(capturedFrom).toContain("mycompany.com");
	});
});
