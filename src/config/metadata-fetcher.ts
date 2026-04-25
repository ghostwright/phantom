// Phase C: tenant Phantom fetches its provider API key from the host metadata
// gateway at boot time instead of reading it from process.env. This file is
// the HTTP client that speaks to http://169.254.169.254/v1/secrets/<name>.
//
// Two security invariants live here:
//   1. Plaintext NEVER appears in error messages, log lines, or thrown errors.
//      Errors carry the secret NAME and HTTP status, never the body.
//   2. Secret name is validated against a strict regex BEFORE the fetch fires.
//      Anything outside [a-z_][a-z0-9_]* is rejected with a clear error so a
//      future caller cannot smuggle path components or query strings into the
//      gateway URL.
//
// Caching: a 60s in-process TTL avoids re-fetching on every Agent SDK
// subprocess spawn. ETag (X-Phantom-Rotation-Id) lets the gateway answer 304
// when the secret has not rotated, refreshing TTL without re-disclosing
// plaintext. Per the brief, no global singleton: loadConfig constructs one
// fetcher per call.

export const METADATA_CACHE_TTL_MS = 60_000;

const VALID_SECRET_NAME = /^[a-z_][a-z0-9_]*$/;

type CacheEntry = {
	value: string;
	rotationId: string;
	fetchedAt: number;
};

export class MetadataSecretFetcher {
	private readonly baseUrl: string;
	private readonly cache = new Map<string, CacheEntry>();

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl;
	}

	async get(name: string): Promise<string> {
		// Defense-in-depth name check. The loader walker enforces the same regex,
		// but a future caller could invoke get() directly. Reject anything that
		// could smuggle a path or query into the gateway URL.
		if (!VALID_SECRET_NAME.test(name)) {
			throw new Error(`metadata: invalid secret name: ${name}`);
		}

		const cached = this.cache.get(name);
		if (cached && Date.now() - cached.fetchedAt < METADATA_CACHE_TTL_MS) {
			return cached.value;
		}

		const url = `${this.baseUrl}/v1/secrets/${encodeURIComponent(name)}`;
		const headers: Record<string, string> = {};
		if (cached) {
			headers["If-None-Match"] = `"${cached.rotationId}"`;
		}

		let res: Response;
		try {
			res = await fetch(url, { method: "GET", headers });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`metadata: fetch ${name} failed: ${msg}`);
		}

		if (res.status === 304) {
			if (!cached) {
				// 304 with no cache is a server bug. Surface it loudly so the operator
				// can investigate; never silently treat this as success.
				throw new Error(`metadata: fetch ${name} failed: HTTP 304 with no cached entry`);
			}
			cached.fetchedAt = Date.now();
			return cached.value;
		}

		if (res.status !== 200) {
			throw new Error(`metadata: fetch ${name} failed: HTTP ${res.status} ${res.statusText}`);
		}

		const value = await res.text();
		const rotationId = res.headers.get("X-Phantom-Rotation-Id") ?? "0";
		this.cache.set(name, { value, rotationId, fetchedAt: Date.now() });
		return value;
	}
}
