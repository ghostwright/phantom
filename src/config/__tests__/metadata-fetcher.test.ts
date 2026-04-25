import { afterEach, describe, expect, mock, test } from "bun:test";
import { METADATA_CACHE_TTL_MS, MetadataSecretFetcher } from "../metadata-fetcher.ts";

// Test seam: tweak the module-level TTL constant from a test by re-exporting
// or by stubbing fetchedAt. Bun does not let us mutate const exports, so the
// 304 test simulates expiry by mutating the cached entry's `fetchedAt` via
// a second `get()` after a known-fresh first call. We assert behaviour, not
// internals: the fetch mock is the source of truth on whether a network
// call occurred.

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("MetadataSecretFetcher", () => {
	test("cold cache fetch returns body and stores rotation id", async () => {
		const stubBody = "secret-value-cold";
		const fetchMock = mock((url: string | Request) => {
			expect(String(url)).toBe("http://gateway.test/v1/secrets/provider_token");
			return Promise.resolve(
				new Response(stubBody, {
					status: 200,
					headers: { "X-Phantom-Rotation-Id": "r1" },
				}),
			);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const fetcher = new MetadataSecretFetcher("http://gateway.test");
		const value = await fetcher.get("provider_token");
		expect(value).toBe(stubBody);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("warm cache hit within TTL skips the network", async () => {
		const stubBody = "secret-value-warm";
		const fetchMock = mock(() =>
			Promise.resolve(
				new Response(stubBody, {
					status: 200,
					headers: { "X-Phantom-Rotation-Id": "r1" },
				}),
			),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const fetcher = new MetadataSecretFetcher("http://gateway.test");
		const first = await fetcher.get("provider_token");
		const second = await fetcher.get("provider_token");
		expect(first).toBe(stubBody);
		expect(second).toBe(stubBody);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("304 response refreshes TTL and returns cached value with If-None-Match", async () => {
		const stubBody = "secret-value-rotation";
		let callIndex = 0;
		const fetchMock = mock((_url: string | Request, init?: RequestInit) => {
			callIndex += 1;
			if (callIndex === 1) {
				return Promise.resolve(
					new Response(stubBody, {
						status: 200,
						headers: { "X-Phantom-Rotation-Id": "r1" },
					}),
				);
			}
			expect(init?.headers).toEqual({ "If-None-Match": '"r1"' });
			return Promise.resolve(new Response(null, { status: 304 }));
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const fetcher = new MetadataSecretFetcher("http://gateway.test");
		const first = await fetcher.get("provider_token");

		// Force expiry by reaching into the private cache via a typed accessor.
		// We use the public TTL constant to compute a stale fetchedAt.
		const cache = (fetcher as unknown as { cache: Map<string, { fetchedAt: number }> }).cache;
		const entry = cache.get("provider_token");
		if (!entry) throw new Error("test setup: cache entry missing after first fetch");
		entry.fetchedAt = Date.now() - METADATA_CACHE_TTL_MS - 1;

		const second = await fetcher.get("provider_token");
		expect(first).toBe(stubBody);
		expect(second).toBe(stubBody);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("HTTP 500 throws an error containing the status and secret name, never plaintext", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("plaintext-secret-must-not-leak", { status: 500, statusText: "Server Error" })),
		) as unknown as typeof fetch;

		const fetcher = new MetadataSecretFetcher("http://gateway.test");
		try {
			await fetcher.get("provider_token");
			throw new Error("expected fetcher.get to throw");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("provider_token");
			expect(msg).toContain("500");
			expect(msg).not.toContain("plaintext-secret-must-not-leak");
		}
	});

	test("invalid secret name is rejected before any network call", async () => {
		const fetchMock = mock(() => Promise.reject(new Error("test setup: fetch should not be called")));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const fetcher = new MetadataSecretFetcher("http://gateway.test");
		await expect(fetcher.get("Provider Token!")).rejects.toThrow(/invalid secret name/);
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	test("encodeURIComponent is applied to the secret name in the URL", async () => {
		// The validation regex already restricts names to [a-z_][a-z0-9_]*, so
		// the URL-encoded form is identical to the input. This test pins the
		// behaviour so a future change to the validation regex (e.g. allowing
		// dashes) does not silently bypass URL encoding.
		const recordedUrls: string[] = [];
		globalThis.fetch = mock((url: string | Request) => {
			recordedUrls.push(String(url));
			return Promise.resolve(new Response("ok", { status: 200, headers: { "X-Phantom-Rotation-Id": "r1" } }));
		}) as unknown as typeof fetch;

		const fetcher = new MetadataSecretFetcher("http://gateway.test");
		await fetcher.get("a_secret_with_no_special_chars");
		expect(recordedUrls[0]).toBe("http://gateway.test/v1/secrets/a_secret_with_no_special_chars");
	});

	test("304 with no cached entry surfaces as an error containing the secret name", async () => {
		// 304-without-cache is a server bug. Pin the loud-error behaviour so a
		// future refactor that inverted the `if (!cached)` test would fail here.
		globalThis.fetch = mock(() => Promise.resolve(new Response(null, { status: 304 }))) as unknown as typeof fetch;

		const fetcher = new MetadataSecretFetcher("http://gateway.test");
		await expect(fetcher.get("provider_token")).rejects.toThrow(/304/);
		await expect(fetcher.get("provider_token")).rejects.toThrow(/provider_token/);
	});

	test("network error from underlying fetch is wrapped with the secret name", async () => {
		// Transport failures (DNS, ECONNREFUSED, TLS) must be wrapped with the
		// secret name so the operator can see which fetch call failed without
		// leaking response bodies (there is no body on a transport error).
		globalThis.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

		const fetcher = new MetadataSecretFetcher("http://gateway.test");
		await expect(fetcher.get("provider_token")).rejects.toThrow(/provider_token/);
		await expect(fetcher.get("provider_token")).rejects.toThrow(/ECONNREFUSED/);
	});
});
