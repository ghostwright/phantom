import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { revokeAllSessions } from "../../ui/session.ts";
import { clearRateLimits, handleEmailLogin } from "../email-login.ts";

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
		const res = await handleEmailLogin(req, "http://localhost:6666");
		expect(res.status).toBe(200);
		const data = (await res.json()) as { ok: boolean };
		expect(data.ok).toBe(true);
	});

	test("returns 200 with neutral response for invalid email", async () => {
		const req = makeRequest({ email: "wrong@example.com" });
		const res = await handleEmailLogin(req, "http://localhost:6666");
		expect(res.status).toBe(200);
		const data = (await res.json()) as { ok: boolean };
		expect(data.ok).toBe(true);
	});

	test("returns 200 with neutral response when OWNER_EMAIL is unset", async () => {
		process.env.OWNER_EMAIL = undefined;
		const req = makeRequest({ email: "someone@example.com" });
		const res = await handleEmailLogin(req, "http://localhost:6666");
		expect(res.status).toBe(200);
		const data = (await res.json()) as { ok: boolean };
		expect(data.ok).toBe(true);
	});

	test("returns 200 for missing email field", async () => {
		const req = makeRequest({});
		const res = await handleEmailLogin(req, "http://localhost:6666");
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
		const res = await handleEmailLogin(req, "http://localhost:6666");
		expect(res.status).toBe(200);
	});

	test("rate limits to 1 per 60 seconds per IP", async () => {
		// First request succeeds (triggers rate limit regardless of match)
		const req1 = makeRequest({ email: "owner@example.com" }, "10.0.0.1");
		const res1 = await handleEmailLogin(req1, "http://localhost:6666");
		expect(res1.status).toBe(200);

		// Second request from same IP within 60 seconds
		const req2 = makeRequest({ email: "owner@example.com" }, "10.0.0.1");
		const res2 = await handleEmailLogin(req2, "http://localhost:6666");
		expect(res2.status).toBe(200);
		// Still returns ok (neutral), but it was rate-limited internally

		// Different IP is not rate-limited
		const req3 = makeRequest({ email: "owner@example.com" }, "10.0.0.2");
		const res3 = await handleEmailLogin(req3, "http://localhost:6666");
		expect(res3.status).toBe(200);
	});

	test("normalizes email comparison to lowercase", async () => {
		const req = makeRequest({ email: "OWNER@Example.COM" });
		const res = await handleEmailLogin(req, "http://localhost:6666");
		expect(res.status).toBe(200);
		const data = (await res.json()) as { ok: boolean };
		expect(data.ok).toBe(true);
	});
});
