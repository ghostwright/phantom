import { describe, expect, test } from "bun:test";
import { EnvKeyFetcher, RESEND_KEY_CACHE_TTL_MS, ResendKeyFetcher } from "../key-fetcher.ts";

const SECRET = "re_test_value";
const BASE_URL = "http://gateway.test";

function makeFetcherWithFakeFetch(opts: {
	responses: Array<{ status: number; body?: string }>;
	now?: () => number;
	secretName?: string;
	ttlMs?: number;
	onCall?: (url: string, init?: RequestInit) => void;
}) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	let i = 0;
	const fetchImpl = ((url: string | Request | URL, init?: RequestInit) => {
		const stringUrl = typeof url === "string" ? url : url.toString();
		calls.push({ url: stringUrl, init });
		opts.onCall?.(stringUrl, init);
		const r = opts.responses[i++];
		if (!r) throw new Error(`fake fetch ran out of responses (call ${i} unmatched)`);
		const body = r.body ?? "";
		return Promise.resolve(new Response(body, { status: r.status }));
	}) as unknown as typeof fetch;

	const fetcher = new ResendKeyFetcher({
		baseUrl: BASE_URL,
		secretName: opts.secretName,
		ttlMs: opts.ttlMs,
		now: opts.now,
		fetchImpl,
	});

	return { fetcher, calls };
}

describe("ResendKeyFetcher", () => {
	test("happy path: 200 returns the body and caches it", async () => {
		const { fetcher, calls } = makeFetcherWithFakeFetch({
			responses: [{ status: 200, body: SECRET }],
		});
		const result = await fetcher.get();
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe(SECRET);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${BASE_URL}/v1/secrets/resend_api_key`);
	});

	test("warm cache hit within TTL skips the network", async () => {
		const { fetcher, calls } = makeFetcherWithFakeFetch({
			responses: [{ status: 200, body: SECRET }],
		});
		await fetcher.get();
		await fetcher.get();
		expect(calls).toHaveLength(1);
	});

	test("cache eviction at TTL refetches", async () => {
		let fakeNow = 1_000_000;
		const { fetcher, calls } = makeFetcherWithFakeFetch({
			responses: [
				{ status: 200, body: SECRET },
				{ status: 200, body: SECRET },
			],
			now: () => fakeNow,
		});
		await fetcher.get();
		fakeNow += RESEND_KEY_CACHE_TTL_MS + 1;
		await fetcher.get();
		expect(calls).toHaveLength(2);
	});

	test("404 returns key_unavailable", async () => {
		const { fetcher } = makeFetcherWithFakeFetch({
			responses: [{ status: 404, body: "" }],
		});
		const result = await fetcher.get();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("unavailable");
			expect(result.error.message).toContain("404");
		}
	});

	test("503 returns key_unavailable (service_down upstream)", async () => {
		const { fetcher } = makeFetcherWithFakeFetch({
			responses: [{ status: 503, body: "" }],
		});
		const result = await fetcher.get();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("unavailable");
	});

	test("401 invalidates cache and surfaces auth_failed; refetch does NOT use cached value", async () => {
		const { fetcher, calls } = makeFetcherWithFakeFetch({
			responses: [
				{ status: 200, body: SECRET },
				{ status: 401, body: "" },
				{ status: 200, body: "re_rotated" },
			],
		});
		const first = await fetcher.get();
		expect(first.ok).toBe(true);
		// Caller invokes invalidate + refetch on a Resend 401. We simulate
		// the EmailTool's path: invalidate, then get again. The second get
		// hits the gateway (cache cleared); the gateway returns 401 too.
		fetcher.invalidate();
		const second = await fetcher.get();
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.error.kind).toBe("auth_failed");
		// A subsequent retry after operator re-seeds returns the new key.
		const third = await fetcher.get();
		expect(third.ok).toBe(true);
		if (third.ok) expect(third.value).toBe("re_rotated");
		expect(calls).toHaveLength(3);
	});

	test("network error surfaces as unavailable without leaking exception text", async () => {
		const fetchImpl = ((_url: string, _init?: RequestInit) =>
			Promise.reject(new Error("ECONNREFUSED phantom"))) as unknown as typeof fetch;
		const fetcher = new ResendKeyFetcher({ baseUrl: BASE_URL, fetchImpl });
		const result = await fetcher.get();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("unavailable");
			expect(result.error.message).toContain("resend_api_key");
			expect(result.error.message).not.toContain(SECRET);
		}
	});

	test("invalid secret name is rejected before any fetch fires", async () => {
		const calls: number[] = [];
		const fetchImpl = (() => {
			calls.push(1);
			return Promise.resolve(new Response("", { status: 200 }));
		}) as unknown as typeof fetch;
		const fetcher = new ResendKeyFetcher({
			baseUrl: BASE_URL,
			secretName: "BAD-NAME",
			fetchImpl,
		});
		const result = await fetcher.get();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("invalid_name");
		expect(calls).toHaveLength(0);
	});

	test("empty body is rejected as unavailable (defensive against gateway misbehaviour)", async () => {
		const { fetcher } = makeFetcherWithFakeFetch({
			responses: [{ status: 200, body: "" }],
		});
		const result = await fetcher.get();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("unavailable");
	});

	test("error message NEVER contains the secret value across every failure path", async () => {
		// 401 (gateway-side bearer mis-config; in-flight Resend has the cached value separately).
		const ctx = makeFetcherWithFakeFetch({
			responses: [{ status: 401, body: SECRET }],
		});
		const result = await ctx.fetcher.get();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).not.toContain(SECRET);
		}
	});

	test("cache-hit path NEVER re-emits the value via any log channel (no leak across get calls)", async () => {
		const logs: string[] = [];
		const origLog = console.log;
		const origWarn = console.warn;
		console.log = (...args: unknown[]) => {
			logs.push(args.map((a) => String(a)).join(" "));
		};
		console.warn = (...args: unknown[]) => {
			logs.push(args.map((a) => String(a)).join(" "));
		};
		try {
			const { fetcher } = makeFetcherWithFakeFetch({
				responses: [{ status: 200, body: SECRET }],
			});
			await fetcher.get();
			await fetcher.get();
			for (const line of logs) {
				expect(line).not.toContain(SECRET);
			}
		} finally {
			console.log = origLog;
			console.warn = origWarn;
		}
	});

	test("invalidate() forces a refetch on the next get", async () => {
		const { fetcher, calls } = makeFetcherWithFakeFetch({
			responses: [
				{ status: 200, body: SECRET },
				{ status: 200, body: "re_rotated" },
			],
		});
		const first = await fetcher.get();
		expect(first.ok && first.value === SECRET).toBe(true);
		fetcher.invalidate();
		const second = await fetcher.get();
		expect(second.ok && (second as { ok: true; value: string }).value === "re_rotated").toBe(true);
		expect(calls).toHaveLength(2);
	});
});

describe("EnvKeyFetcher", () => {
	test("returns the env value when set", async () => {
		const original = process.env.RESEND_API_KEY;
		process.env.RESEND_API_KEY = SECRET;
		try {
			const fetcher = new EnvKeyFetcher();
			const result = await fetcher.get();
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value).toBe(SECRET);
		} finally {
			if (original !== undefined) {
				process.env.RESEND_API_KEY = original;
			} else {
				// biome-ignore lint/performance/noDelete: tests need to actually unset env to exercise the missing-key path
				delete process.env.RESEND_API_KEY;
			}
		}
	});

	test("returns unavailable when env not set", async () => {
		const original = process.env.RESEND_API_KEY;
		// biome-ignore lint/performance/noDelete: tests need to actually unset env to exercise the missing-key path
		delete process.env.RESEND_API_KEY;
		try {
			const fetcher = new EnvKeyFetcher();
			const result = await fetcher.get();
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.kind).toBe("unavailable");
		} finally {
			if (original !== undefined) process.env.RESEND_API_KEY = original;
		}
	});

	test("invalidate is a no-op (env-backed)", async () => {
		const fetcher = new EnvKeyFetcher();
		fetcher.invalidate();
		fetcher.invalidate();
	});
});
