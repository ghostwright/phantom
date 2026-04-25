import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_METADATA_BASE_URL, MetadataIdentityFetcher } from "../identity-fetcher.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const minimalIdentity = {
	tenant_id: "ten_alpha",
	tenant_slug: "alpha",
	region: "eu-central-1",
	host_id: "host-01",
	env: "prod",
	source_ip: "10.0.0.5",
	fleet_rotation_counter: 0,
	supported_secret_name_patterns: [],
};

describe("MetadataIdentityFetcher", () => {
	test("DEFAULT_METADATA_BASE_URL points at the link-local address", () => {
		expect(DEFAULT_METADATA_BASE_URL).toBe("http://169.254.169.254");
	});

	test("returns parsed identity on 200", async () => {
		globalThis.fetch = mock((url: string | Request) => {
			expect(String(url)).toBe("http://gateway.test/v1/identity");
			return Promise.resolve(new Response(JSON.stringify(minimalIdentity), { status: 200 }));
		}) as unknown as typeof fetch;

		const fetcher = new MetadataIdentityFetcher("http://gateway.test");
		const id = await fetcher.get();
		expect(id.tenantId).toBe("ten_alpha");
		expect(id.tenantSlug).toBe("alpha");
		expect(id.region).toBe("eu-central-1");
		expect(id.hostId).toBe("host-01");
		expect(id.env).toBe("prod");
		expect(id.slack).toBeUndefined();
	});

	test("parses slack subfield when present", async () => {
		const withSlack = {
			...minimalIdentity,
			slack: {
				team_id: "T9TK3CUKW",
				installer_user_id: "U061F7AUR",
				team_name: "Acme Corp",
				installed_at: "2026-04-25T12:00:00Z",
			},
		};
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify(withSlack), { status: 200 })),
		) as unknown as typeof fetch;

		const fetcher = new MetadataIdentityFetcher("http://gateway.test");
		const id = await fetcher.get();
		expect(id.slack).toBeDefined();
		expect(id.slack?.teamId).toBe("T9TK3CUKW");
		expect(id.slack?.installerUserId).toBe("U061F7AUR");
		expect(id.slack?.teamName).toBe("Acme Corp");
		expect(id.slack?.installedAt).toBe("2026-04-25T12:00:00Z");
	});

	test("treats slack: null as no install (defensive over JSON encoders)", async () => {
		// Phantomd uses omitempty so the wire never carries `"slack": null`,
		// but a forwarding proxy or future encoder could. Tolerate both.
		const withNull = { ...minimalIdentity, slack: null };
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify(withNull), { status: 200 })),
		) as unknown as typeof fetch;

		const fetcher = new MetadataIdentityFetcher("http://gateway.test");
		const id = await fetcher.get();
		expect(id.slack).toBeUndefined();
	});

	test("HTTP 500 throws with status, never with body", async () => {
		// The /v1/identity body is not a secret, but error messages that quote
		// response bodies tend to grow teeth. Keep error context to status only.
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("internal error", { status: 500, statusText: "Server Error" })),
		) as unknown as typeof fetch;

		const fetcher = new MetadataIdentityFetcher("http://gateway.test");
		try {
			await fetcher.get();
			throw new Error("expected get() to throw");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).toContain("500");
			expect(msg).toContain("identity");
			expect(msg).not.toContain("internal error");
		}
	});

	test("network error wraps with 'metadata: fetch identity failed'", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

		const fetcher = new MetadataIdentityFetcher("http://gateway.test");
		await expect(fetcher.get()).rejects.toThrow(/metadata: fetch identity failed/);
		await expect(fetcher.get()).rejects.toThrow(/ECONNREFUSED/);
	});

	test("malformed JSON surfaces a clear error", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("<html>not json</html>", { status: 200 })),
		) as unknown as typeof fetch;

		const fetcher = new MetadataIdentityFetcher("http://gateway.test");
		await expect(fetcher.get()).rejects.toThrow(/malformed JSON/);
	});

	test("missing tenant_id throws", async () => {
		const broken = { ...minimalIdentity };
		// biome-ignore lint/performance/noDelete: deliberate field deletion for test
		delete (broken as Record<string, unknown>).tenant_id;
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify(broken), { status: 200 })),
		) as unknown as typeof fetch;

		const fetcher = new MetadataIdentityFetcher("http://gateway.test");
		await expect(fetcher.get()).rejects.toThrow(/tenant_id is not a string/);
	});

	test("slack subfield missing team_id throws", async () => {
		const broken = {
			...minimalIdentity,
			slack: { installer_user_id: "U1", team_name: "x", installed_at: "2026-04-25T12:00:00Z" },
		};
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify(broken), { status: 200 })),
		) as unknown as typeof fetch;

		const fetcher = new MetadataIdentityFetcher("http://gateway.test");
		await expect(fetcher.get()).rejects.toThrow(/slack\.team_id is not a string/);
	});

	test("slack subfield with null team_id throws", async () => {
		const broken = {
			...minimalIdentity,
			slack: { team_id: null, installer_user_id: "U1", team_name: "x", installed_at: "z" },
		};
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify(broken), { status: 200 })),
		) as unknown as typeof fetch;

		const fetcher = new MetadataIdentityFetcher("http://gateway.test");
		await expect(fetcher.get()).rejects.toThrow(/slack\.team_id is not a string/);
	});

	test("slack non-object value throws", async () => {
		const broken = { ...minimalIdentity, slack: "not-an-object" };
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify(broken), { status: 200 })),
		) as unknown as typeof fetch;

		const fetcher = new MetadataIdentityFetcher("http://gateway.test");
		await expect(fetcher.get()).rejects.toThrow(/identity\.slack is not an object/);
	});

	test("non-object response body throws", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(JSON.stringify("just a string"), { status: 200 })),
		) as unknown as typeof fetch;

		const fetcher = new MetadataIdentityFetcher("http://gateway.test");
		await expect(fetcher.get()).rejects.toThrow(/identity response is not an object/);
	});
});
