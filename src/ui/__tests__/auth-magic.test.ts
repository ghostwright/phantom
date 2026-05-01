// Phase 6 PR-3 (2026-05-01) tests for the per-tenant /auth/magic
// callback. Mirrors the architect §13 (test plan) + the failure-path
// + refresh-survival track per feedback_reviewer_failure_path_track.
//
// The tests stub the validator hop with a fake fetcher. The real
// validator lives at http://169.254.169.254/v1/magic-link/validate
// inside the VM (phantomd metadata-gateway proxy); we never hit it
// from a unit test. Instead we exercise the full handler logic:
// shape gate, rate limit, cross-tenant defense, owner_email gate,
// cookie minting, error redirects, plaintext-discipline.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type MagicAuthDeps,
	type MagicAuthFetcher,
	clearAuthMagicRateLimitsForTests,
	handleAuthMagic,
} from "../auth-magic.ts";
import { isValidSession, revokeAllSessions } from "../session.ts";

// Build a 43-char base64url-clean token. Each test gets a fresh
// token so rate-limit + replay tests cannot accidentally collide
// across the suite.
function freshToken(): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	let out = "";
	for (let i = 0; i < 43; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
	return out;
}

const TENANT_SLUG = "gilded-hearth";
const OWNER_EMAIL = "owner@example.com";
const DASHBOARD_URL = "https://app.ghostwright.dev";
const METADATA_BASE_URL = "http://169.254.169.254";

interface FakeFetchCall {
	url: string;
	body: string;
	method: string;
}

interface FakeFetchOptions {
	status?: number;
	jsonResponse?: unknown;
	throws?: Error;
	delayMs?: number;
}

function makeFakeFetch(opts: FakeFetchOptions = {}): {
	fetcher: MagicAuthFetcher;
	calls: FakeFetchCall[];
} {
	const calls: FakeFetchCall[] = [];
	const fetcher: MagicAuthFetcher = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const body = typeof init?.body === "string" ? init.body : "";
		const method = init?.method ?? "GET";
		calls.push({ url, body, method });
		if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
		if (opts.throws) throw opts.throws;
		const status = opts.status ?? 200;
		const responseBody = opts.jsonResponse ?? {
			agent_id: "00000000-0000-0000-0000-000000000001",
			agent_slug: TENANT_SLUG,
			owner_email: OWNER_EMAIL,
		};
		return new Response(typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	};
	return { fetcher, calls };
}

function makeDeps(overrides: Partial<MagicAuthDeps> = {}): MagicAuthDeps {
	const { fetcher } = makeFakeFetch();
	return {
		fetcher,
		clock: () => Date.now(),
		metadataBaseUrl: METADATA_BASE_URL,
		dashboardUrl: DASHBOARD_URL,
		tenantSlug: TENANT_SLUG,
		ownerEmail: OWNER_EMAIL,
		...overrides,
	};
}

function magicReq(query = "", opts: { ip?: string; method?: string } = {}): Request {
	const url = `https://${TENANT_SLUG}.phantom.ghostwright.dev/auth/magic${query}`;
	const headers: Record<string, string> = {};
	if (opts.ip) headers["X-Forwarded-For"] = opts.ip;
	return new Request(url, { method: opts.method ?? "GET", headers });
}

beforeEach(() => {
	clearAuthMagicRateLimitsForTests();
});

afterEach(() => {
	clearAuthMagicRateLimitsForTests();
	revokeAllSessions();
});

describe("handleAuthMagic - happy path", () => {
	test("valid token, validator 200 -> 302 with Set-Cookie + redirect to /chat", async () => {
		const token = freshToken();
		const { fetcher, calls } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "1.2.3.4" }), deps);

		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/chat");

		const setCookies = res.headers.getSetCookie();
		expect(setCookies.length).toBeGreaterThanOrEqual(1);
		const sessionCookie = setCookies.find((c) => c.startsWith("phantom_session=") && !c.includes("Max-Age=0"));
		expect(sessionCookie).toBeDefined();
		expect(sessionCookie).toContain("HttpOnly");
		expect(sessionCookie).toContain("Secure");
		expect(sessionCookie).toContain("SameSite=Lax");
		expect(sessionCookie).toContain("Path=/");
		expect(sessionCookie).toContain("Max-Age=604800");

		// The validator was called exactly once with the token in the
		// JSON body (NOT the URL).
		expect(calls.length).toBe(1);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url).toBe(`${METADATA_BASE_URL}/v1/magic-link/validate`);
		expect(calls[0].url).not.toContain(token);
		expect(calls[0].body).toContain(token);
	});

	test("session token in cookie is valid against isValidSession", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "1.2.3.5" }), deps);
		expect(res.status).toBe(302);

		const setCookies = res.headers.getSetCookie();
		const cookie = setCookies.find((c) => c.startsWith("phantom_session=") && !c.includes("Max-Age=0"));
		expect(cookie).toBeDefined();
		const value = cookie?.split(";")[0]?.split("=")[1] ?? "";
		expect(value.length).toBeGreaterThan(0);
		expect(isValidSession(value)).toBe(true);
	});

	test("path-only redirect param is preserved", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}&redirect=/chat/sessions/abc`, { ip: "1.2.3.6" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/chat/sessions/abc");
	});

	test("Set-Cookie carries Domain attribute when PHANTOM_DOMAIN is set", async () => {
		const previous = process.env.PHANTOM_DOMAIN;
		process.env.PHANTOM_DOMAIN = `${TENANT_SLUG}.phantom.ghostwright.dev`;
		try {
			const token = freshToken();
			const { fetcher } = makeFakeFetch();
			const deps = makeDeps({ fetcher });
			const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "1.2.3.7" }), deps);
			expect(res.status).toBe(302);
			const setCookies = res.headers.getSetCookie();
			const cookie = setCookies.find((c) => c.startsWith("phantom_session=") && !c.includes("Max-Age=0"));
			expect(cookie).toContain(`Domain=${TENANT_SLUG}.phantom.ghostwright.dev`);
		} finally {
			if (previous === undefined) process.env.PHANTOM_DOMAIN = undefined;
			else process.env.PHANTOM_DOMAIN = previous;
		}
	});

	test("Set-Cookie omits Domain when PHANTOM_DOMAIN is unset (dev mode)", async () => {
		const previous = process.env.PHANTOM_DOMAIN;
		process.env.PHANTOM_DOMAIN = undefined;
		try {
			const token = freshToken();
			const { fetcher } = makeFakeFetch();
			const deps = makeDeps({ fetcher });
			const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "1.2.3.8" }), deps);
			expect(res.status).toBe(302);
			const setCookies = res.headers.getSetCookie();
			const cookie = setCookies.find((c) => c.startsWith("phantom_session=") && !c.includes("Max-Age=0"));
			expect(cookie).toBeDefined();
			expect(cookie).not.toContain("Domain=");
		} finally {
			if (previous !== undefined) process.env.PHANTOM_DOMAIN = previous;
		}
	});

	test("legacy Path=/ui cookie is cleared on success", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "1.2.3.9" }), deps);
		expect(res.status).toBe(302);
		const setCookies = res.headers.getSetCookie();
		const stale = setCookies.find((c) => c.includes("Path=/ui") && c.includes("Max-Age=0"));
		expect(stale).toBeDefined();
	});

	test("PHANTOM_DOMAIN with accidental https:// prefix is normalized", async () => {
		const previous = process.env.PHANTOM_DOMAIN;
		process.env.PHANTOM_DOMAIN = "https://gilded-hearth.phantom.ghostwright.dev/";
		try {
			const token = freshToken();
			const { fetcher } = makeFakeFetch();
			const deps = makeDeps({ fetcher });
			const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "1.2.3.10" }), deps);
			const setCookies = res.headers.getSetCookie();
			const cookie = setCookies.find((c) => c.startsWith("phantom_session=") && !c.includes("Max-Age=0"));
			expect(cookie).toContain("Domain=gilded-hearth.phantom.ghostwright.dev");
			expect(cookie).not.toContain("https://");
		} finally {
			if (previous === undefined) process.env.PHANTOM_DOMAIN = undefined;
			else process.env.PHANTOM_DOMAIN = previous;
		}
	});
});

describe("handleAuthMagic - input shape gate", () => {
	test("missing token redirects to error without invoking validator", async () => {
		const { fetcher, calls } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq("", { ip: "5.5.5.5" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=invalid_token`);
		expect(calls.length).toBe(0);
		expect(res.headers.getSetCookie()).toEqual([]);
	});

	test("malformed token (too short) redirects without invoking validator", async () => {
		const { fetcher, calls } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq("?token=tooshort", { ip: "5.5.5.6" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=invalid_token`);
		expect(calls.length).toBe(0);
	});

	test("malformed token (44 chars - off by one) is rejected", async () => {
		const { fetcher, calls } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${"a".repeat(44)}`, { ip: "5.5.5.7" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toContain("magic_error=invalid_token");
		expect(calls.length).toBe(0);
	});

	test("malformed token (illegal char +) is rejected", async () => {
		const { fetcher, calls } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${"a".repeat(42)}+a`, { ip: "5.5.5.8" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toContain("magic_error=invalid_token");
		expect(calls.length).toBe(0);
	});

	test("non-GET methods return 405 without consuming rate-limit budget", async () => {
		const { fetcher, calls } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${freshToken()}`, { ip: "5.5.5.9", method: "POST" }), deps);
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET");
		expect(calls.length).toBe(0);
	});
});

describe("handleAuthMagic - validator failure paths", () => {
	test("validator 404 -> ?magic_error=expired", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch({ status: 404, jsonResponse: "token invalid" });
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "6.6.6.1" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=expired`);
		expect(res.headers.getSetCookie()).toEqual([]);
	});

	test("validator 400 -> ?magic_error=invalid_token", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch({ status: 400, jsonResponse: "invalid token shape" });
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "6.6.6.2" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=invalid_token`);
	});

	test("validator 403 (cross-tenant) -> ?magic_error=agent_mismatch", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch({ status: 403, jsonResponse: "cross-tenant validate rejected" });
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "6.6.6.3" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=agent_mismatch`);
	});

	test("validator 429 -> ?magic_error=rate_limited", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch({ status: 429, jsonResponse: "rate limit exceeded" });
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "6.6.6.4" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=rate_limited`);
	});

	test("validator 500 -> ?magic_error=validator_unavailable", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch({ status: 500, jsonResponse: "internal" });
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "6.6.6.5" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=validator_unavailable`);
	});

	test("validator 503 -> ?magic_error=validator_unavailable", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch({ status: 503, jsonResponse: "validator unavailable" });
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "6.6.6.6" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=validator_unavailable`);
	});

	test("validator network error -> ?magic_error=validator_unavailable", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch({ throws: new TypeError("fetch failed") });
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "6.6.6.7" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=validator_unavailable`);
	});

	test("validator timeout -> ?magic_error=validator_unavailable", async () => {
		const token = freshToken();
		// Use AbortError to simulate the AbortSignal.timeout firing.
		const abortErr = new DOMException("The operation was aborted", "AbortError");
		const { fetcher } = makeFakeFetch({ throws: abortErr });
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "6.6.6.8" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=validator_unavailable`);
	});

	test("validator returns malformed JSON shape -> ?magic_error=validator_unavailable", async () => {
		const token = freshToken();
		// Missing required fields.
		const { fetcher } = makeFakeFetch({ status: 200, jsonResponse: { agent_id: "abc" } });
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "6.6.6.9" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=validator_unavailable`);
	});

	test("validator returns non-JSON body -> ?magic_error=validator_unavailable", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch({ status: 200, jsonResponse: "not-json-at-all" });
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "6.6.6.10" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=validator_unavailable`);
	});
});

describe("handleAuthMagic - cross-tenant defense", () => {
	test("validator returns agent_slug != PHANTOM_TENANT_SLUG -> 302 agent_mismatch", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch({
			status: 200,
			jsonResponse: {
				agent_id: "00000000-0000-0000-0000-000000000002",
				agent_slug: "different-tenant",
				owner_email: OWNER_EMAIL,
			},
		});
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "7.7.7.1" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=agent_mismatch`);
		expect(res.headers.getSetCookie()).toEqual([]);
	});

	test("agent_slug with whitespace differs from tenantSlug after trim", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch({
			status: 200,
			jsonResponse: {
				agent_id: "00000000-0000-0000-0000-000000000003",
				agent_slug: ` ${TENANT_SLUG} `,
				owner_email: OWNER_EMAIL,
			},
		});
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "7.7.7.2" }), deps);
		// trim() in the handler strips whitespace, so this still matches.
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/chat");
	});
});

describe("handleAuthMagic - owner_email gate", () => {
	test("validator returns owner_email != PHANTOM_OWNER_EMAIL -> 302 owner_mismatch", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch({
			status: 200,
			jsonResponse: {
				agent_id: "00000000-0000-0000-0000-000000000004",
				agent_slug: TENANT_SLUG,
				owner_email: "intruder@example.com",
			},
		});
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "8.8.8.1" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=owner_mismatch`);
		expect(res.headers.getSetCookie()).toEqual([]);
	});

	test("owner_email comparison is case-insensitive", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch({
			status: 200,
			jsonResponse: {
				agent_id: "00000000-0000-0000-0000-000000000005",
				agent_slug: TENANT_SLUG,
				owner_email: OWNER_EMAIL.toUpperCase(),
			},
		});
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "8.8.8.2" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/chat");
	});
});

describe("handleAuthMagic - tenant misconfiguration", () => {
	test("missing PHANTOM_TENANT_SLUG -> 302 tenant_unconfigured", async () => {
		const token = freshToken();
		const { fetcher, calls } = makeFakeFetch();
		const deps = makeDeps({ fetcher, tenantSlug: "" });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "9.9.9.1" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=tenant_unconfigured`);
		// Validator must NOT be invoked when tenant is unconfigured.
		expect(calls.length).toBe(0);
	});

	test("missing PHANTOM_OWNER_EMAIL -> 302 tenant_unconfigured", async () => {
		const token = freshToken();
		const { fetcher, calls } = makeFakeFetch();
		const deps = makeDeps({ fetcher, ownerEmail: "" });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "9.9.9.2" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=tenant_unconfigured`);
		expect(calls.length).toBe(0);
	});
});

describe("handleAuthMagic - rate limit", () => {
	test("11th attempt within 60s window from same IP returns rate_limited", async () => {
		// Fix the clock so all 11 attempts land in the same window.
		let now = 1_700_000_000_000;
		const { fetcher } = makeFakeFetch();
		const deps = makeDeps({ fetcher, clock: () => now });
		const ip = "10.10.10.1";

		// Use 10 valid (well-formed) tokens to exhaust the budget.
		for (let i = 0; i < 10; i++) {
			const res = await handleAuthMagic(magicReq(`?token=${freshToken()}`, { ip }), deps);
			expect(res.status).toBe(302);
			expect(res.headers.get("Location")).toBe("/chat");
			now += 100;
		}

		// 11th attempt within the same minute is blocked.
		const res11 = await handleAuthMagic(magicReq(`?token=${freshToken()}`, { ip }), deps);
		expect(res11.status).toBe(302);
		expect(res11.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=rate_limited`);
	});

	test("rate-limited request does NOT invoke the validator", async () => {
		let now = 1_700_001_000_000;
		const { fetcher, calls } = makeFakeFetch();
		const deps = makeDeps({ fetcher, clock: () => now });
		const ip = "10.10.10.2";
		// Burn the budget.
		for (let i = 0; i < 10; i++) {
			await handleAuthMagic(magicReq(`?token=${freshToken()}`, { ip }), deps);
			now += 50;
		}
		const callsBefore = calls.length;
		expect(callsBefore).toBe(10);

		// 11th request blocked before validator hop.
		const res = await handleAuthMagic(magicReq(`?token=${freshToken()}`, { ip }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toContain("magic_error=rate_limited");
		expect(calls.length).toBe(callsBefore);
	});

	test("malformed-token requests do NOT consume the budget", async () => {
		let now = 1_700_002_000_000;
		const { fetcher } = makeFakeFetch();
		const deps = makeDeps({ fetcher, clock: () => now });
		const ip = "10.10.10.3";

		// Send 20 malformed-shape requests; none should burn the budget.
		for (let i = 0; i < 20; i++) {
			await handleAuthMagic(magicReq("?token=tooshort", { ip }), deps);
			now += 10;
		}

		// A legitimate request still works; the budget is intact.
		const res = await handleAuthMagic(magicReq(`?token=${freshToken()}`, { ip }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/chat");
	});

	test("attempts outside the 60s window do not count", async () => {
		let now = 1_700_003_000_000;
		const { fetcher } = makeFakeFetch();
		const deps = makeDeps({ fetcher, clock: () => now });
		const ip = "10.10.10.4";

		// Burn 10 attempts at t=0.
		for (let i = 0; i < 10; i++) {
			await handleAuthMagic(magicReq(`?token=${freshToken()}`, { ip }), deps);
		}

		// Move the clock 65 seconds forward; the window slides past
		// every prior attempt.
		now += 65_000;

		const res = await handleAuthMagic(magicReq(`?token=${freshToken()}`, { ip }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/chat");
	});

	test("different IPs have independent budgets", async () => {
		let now = 1_700_004_000_000;
		const { fetcher } = makeFakeFetch();
		const deps = makeDeps({ fetcher, clock: () => now });

		// Burn IP-A budget.
		for (let i = 0; i < 10; i++) {
			await handleAuthMagic(magicReq(`?token=${freshToken()}`, { ip: "11.11.11.1" }), deps);
			now += 50;
		}
		const blocked = await handleAuthMagic(magicReq(`?token=${freshToken()}`, { ip: "11.11.11.1" }), deps);
		expect(blocked.headers.get("Location")).toContain("magic_error=rate_limited");

		// IP-B is fresh.
		const fresh = await handleAuthMagic(magicReq(`?token=${freshToken()}`, { ip: "11.11.11.2" }), deps);
		expect(fresh.headers.get("Location")).toBe("/chat");
	});
});

describe("handleAuthMagic - open redirect defense", () => {
	test("redirect=https://evil.com is ignored, falls back to /chat", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(
			magicReq(`?token=${token}&redirect=https://evil.com/path`, { ip: "12.12.12.1" }),
			deps,
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/chat");
	});

	test("redirect=//evil.com (protocol-relative) is ignored", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(
			magicReq(`?token=${token}&redirect=${encodeURIComponent("//evil.com/path")}`, { ip: "12.12.12.2" }),
			deps,
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/chat");
	});

	test("redirect with backslash trick is ignored", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(
			magicReq(`?token=${token}&redirect=${encodeURIComponent("/\\evil.com")}`, { ip: "12.12.12.3" }),
			deps,
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/chat");
	});

	test("redirect=javascript:alert is ignored (does not start with /)", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(
			magicReq(`?token=${token}&redirect=javascript:alert(1)`, { ip: "12.12.12.4" }),
			deps,
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/chat");
	});
});

describe("handleAuthMagic - plaintext-leak guards", () => {
	test("token is NEVER in the upstream URL path or query", async () => {
		const token = freshToken();
		const { fetcher, calls } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		await handleAuthMagic(magicReq(`?token=${token}`, { ip: "13.13.13.1" }), deps);
		expect(calls.length).toBe(1);
		expect(calls[0].url).toBe(`${METADATA_BASE_URL}/v1/magic-link/validate`);
		const u = new URL(calls[0].url);
		expect(u.pathname).toBe("/v1/magic-link/validate");
		expect(u.search).toBe("");
		expect(calls[0].url).not.toContain(token);
	});

	test("token is NEVER in the error redirect Location on any failure path", async () => {
		const token = freshToken();
		const failureCases: Array<{ name: string; opts: FakeFetchOptions }> = [
			{ name: "404", opts: { status: 404 } },
			{ name: "500", opts: { status: 500 } },
			{ name: "503", opts: { status: 503 } },
			{ name: "throw", opts: { throws: new Error("boom") } },
		];
		for (const { name, opts } of failureCases) {
			const { fetcher } = makeFakeFetch(opts);
			const deps = makeDeps({ fetcher });
			const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: `13.13.13.${name}` }), deps);
			expect(res.status).toBe(302);
			const loc = res.headers.get("Location") ?? "";
			expect(loc).not.toContain(token);
		}
	});

	test("token is NEVER in the response body on any failure path", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch({ status: 500 });
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "13.13.13.5" }), deps);
		const body = await res.text();
		expect(body).not.toContain(token);
	});

	test("token is NEVER in the structured log line on success", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		// Capture console.log output for the duration of this test.
		const original = console.log;
		const logs: string[] = [];
		console.log = (...args: unknown[]) => {
			logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
		};
		try {
			const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "13.13.13.6" }), deps);
			expect(res.status).toBe(302);
			for (const line of logs) {
				expect(line).not.toContain(token);
			}
		} finally {
			console.log = original;
		}
	});

	test("token is NEVER in the response body on success (just empty body)", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch();
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "13.13.13.7" }), deps);
		const body = await res.text();
		expect(body).toBe("");
		expect(body).not.toContain(token);
	});
});

describe("handleAuthMagic - dashboard URL fallback", () => {
	test("missing PHANTOM_DASHBOARD_URL falls back to /ui/login on error", async () => {
		const { fetcher } = makeFakeFetch();
		const deps = makeDeps({ fetcher, dashboardUrl: "" });
		const res = await handleAuthMagic(magicReq("", { ip: "14.14.14.1" }), deps);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/ui/login?magic_error=invalid_token");
	});
});

describe("handleAuthMagic - refresh survival", () => {
	test("second hit on a consumed token (validator 404) does NOT re-mint a session", async () => {
		const token = freshToken();
		// First call: validator returns 200 (token still alive).
		const ok1 = makeFakeFetch();
		const deps1 = makeDeps({ fetcher: ok1.fetcher });
		const res1 = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "15.15.15.1" }), deps1);
		expect(res1.status).toBe(302);
		expect(res1.headers.get("Location")).toBe("/chat");

		// Second call: validator returns 404 (token consumed).
		const ok2 = makeFakeFetch({ status: 404 });
		const deps2 = makeDeps({ fetcher: ok2.fetcher });
		const res2 = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "15.15.15.2" }), deps2);
		expect(res2.status).toBe(302);
		expect(res2.headers.get("Location")).toBe(`${DASHBOARD_URL}?magic_error=expired`);
		expect(res2.headers.getSetCookie()).toEqual([]);
	});

	test("refresh after a network failure leaves no half-set cookie", async () => {
		const token = freshToken();
		const { fetcher } = makeFakeFetch({ throws: new TypeError("fetch failed") });
		const deps = makeDeps({ fetcher });
		const res = await handleAuthMagic(magicReq(`?token=${token}`, { ip: "15.15.15.3" }), deps);
		expect(res.status).toBe(302);
		const setCookies = res.headers.getSetCookie();
		expect(setCookies).toEqual([]);
	});
});
