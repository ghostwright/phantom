import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { loadConfig } from "../loader.ts";

// Distinct TEST_DIR from loader.test.ts so the two suites cannot race on the
// same filesystem path when bun runs them in parallel.
const TEST_DIR = "/tmp/phantom-test-config-metadata";

function writeYaml(filename: string, content: string): string {
	mkdirSync(TEST_DIR, { recursive: true });
	const path = `${TEST_DIR}/${filename}`;
	writeFileSync(path, content);
	return path;
}

function cleanup(): void {
	rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("loadConfig secret_source", () => {
	const originalFetch = globalThis.fetch;
	const savedKey = process.env.ANTHROPIC_API_KEY;
	const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;

	beforeEach(() => {
		process.env.ANTHROPIC_API_KEY = undefined;
		process.env.ANTHROPIC_AUTH_TOKEN = undefined;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (savedKey !== undefined) {
			process.env.ANTHROPIC_API_KEY = savedKey;
		} else {
			process.env.ANTHROPIC_API_KEY = undefined;
		}
		if (savedToken !== undefined) {
			process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
		} else {
			process.env.ANTHROPIC_AUTH_TOKEN = undefined;
		}
		cleanup();
	});

	test("secret_source defaults to 'env' when omitted from YAML", async () => {
		const path = writeYaml("default-source.yaml", "name: default-source");
		const config = await loadConfig(path);
		expect(config.secret_source).toBe("env");
		expect(config.secret_source_url).toBeUndefined();
	});

	test("secret_source: metadata populates ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from gateway", async () => {
		// Body deliberately not asserted as a string literal anywhere; we read it
		// back from process.env and compare to the stub-injected reference.
		const stubBody = "stub-token-value";
		globalThis.fetch = mock((url: string | Request) => {
			expect(String(url)).toBe("http://gateway.test/v1/secrets/provider_token");
			return Promise.resolve(
				new Response(stubBody, {
					status: 200,
					headers: { "X-Phantom-Rotation-Id": "1" },
				}),
			);
		}) as unknown as typeof fetch;

		const path = writeYaml(
			"metadata-source.yaml",
			`
name: metadata-tenant
secret_source: metadata
secret_source_url: http://gateway.test
`,
		);
		await loadConfig(path);
		expect(process.env.ANTHROPIC_API_KEY).toBe(stubBody);
		expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe(stubBody);
	});

	test("secret_source: metadata resolves whole-string ${secret:NAME} references in nested config", async () => {
		// Use peers.test_peer.token, an existing schema field that accepts an
		// arbitrary string and is nested. We assert the resolved value via a
		// non-logging path: read it back from the returned config object.
		const peerSecret = "peer-secret-payload";
		globalThis.fetch = mock((url: string | Request) => {
			const u = String(url);
			if (u.endsWith("/v1/secrets/provider_token")) {
				return Promise.resolve(
					new Response("provider-token-value", { status: 200, headers: { "X-Phantom-Rotation-Id": "1" } }),
				);
			}
			if (u.endsWith("/v1/secrets/peer_token")) {
				return Promise.resolve(new Response(peerSecret, { status: 200, headers: { "X-Phantom-Rotation-Id": "1" } }));
			}
			throw new Error(`unexpected URL in test: ${u}`);
		}) as unknown as typeof fetch;

		const path = writeYaml(
			"metadata-walker.yaml",
			`
name: walker-tenant
secret_source: metadata
secret_source_url: http://gateway.test
peers:
  test_peer:
    url: https://peer.test
    token: \${secret:peer_token}
`,
		);
		const config = await loadConfig(path);
		expect(config.peers?.test_peer?.token).toBe(peerSecret);
	});

	test("secret_source: metadata does NOT resolve partial-string ${secret:NAME} (security invariant)", async () => {
		// Whole-string-only matching guards against secret leakage via logged
		// URLs or composed strings. If this test ever fails, the regex changed
		// in a way that allows partial interpolation, which is a security regression.
		const partial = "https://peer.test/?token=${secret:peer_token}";
		globalThis.fetch = mock((url: string | Request) => {
			const u = String(url);
			if (u.endsWith("/v1/secrets/provider_token")) {
				return Promise.resolve(
					new Response("provider-token-value", { status: 200, headers: { "X-Phantom-Rotation-Id": "1" } }),
				);
			}
			throw new Error(`unexpected URL in test (partial-string should NOT trigger fetch): ${u}`);
		}) as unknown as typeof fetch;

		const path = writeYaml(
			"metadata-partial.yaml",
			`
name: partial-tenant
secret_source: metadata
secret_source_url: http://gateway.test
peers:
  test_peer:
    url: ${partial}
    token: keep-as-is
`,
		);
		const config = await loadConfig(path);
		expect(config.peers?.test_peer?.url).toBe(partial);
		expect(config.peers?.test_peer?.token).toBe("keep-as-is");
	});

	test("secret_source: metadata surfaces fetch failures as errors that include the secret name", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("internal error", { status: 500, statusText: "Internal Server Error" })),
		) as unknown as typeof fetch;

		const path = writeYaml(
			"metadata-fail.yaml",
			`
name: fail-tenant
secret_source: metadata
secret_source_url: http://gateway.test
`,
		);
		await expect(loadConfig(path)).rejects.toThrow(/provider_token/);
		await expect(loadConfig(path)).rejects.toThrow(/500/);
	});

	test("invalid provider.secret_name rejects at loadConfig parse time with a schema error", async () => {
		// Phase C #5 review Finding 1: pinning the regex at the schema level
		// surfaces bad names at parse time rather than crashing at boot inside
		// the metadata fetcher. We use secret_source: env so no fetcher is
		// constructed; the rejection must come from PhantomConfigSchema itself.
		const path = writeYaml(
			"bad-secret-name.yaml",
			`
name: bad-name-tenant
provider:
  type: anthropic
  secret_name: Bad-Name
`,
		);
		await expect(loadConfig(path)).rejects.toThrow(/Invalid config/);
		await expect(loadConfig(path)).rejects.toThrow(/secret_name/);
	});
});
