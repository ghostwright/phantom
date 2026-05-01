// Phase 10 PR 10-3: in-VM Phantom client for fetching the operator's Resend
// API key from phantomd's metadata gateway. Mirrors the pattern in
// `src/config/metadata-fetcher.ts` (which serves provider tokens) but adds
// a few Resend-specific behaviors:
//
//   - 15-minute cache TTL (architect §3.4 + §6.6). Long enough that a busy
//     agent does not refetch on every send; short enough that an operator
//     rotation reaches every tenant within 15 minutes.
//   - 401 cache invalidation. If Resend rejects the cached key as revoked,
//     the fetcher invalidates the cache and refetches once. A second 401
//     surfaces as `key_unavailable` and the tool maps it to `auth_failed`
//     in the agent-visible error envelope.
//   - Mapped error kinds. The fetcher returns a structured error object so
//     the EmailTool can route to the correct `error_kind` without parsing
//     prose (architect §6.8 seven-kind taxonomy).
//
// Security invariants (mirrored from `metadata-fetcher.ts`):
//
//   1. Plaintext NEVER appears in error messages, log lines, or thrown
//      errors. Errors carry the secret NAME and HTTP status, never the body.
//   2. Secret name is validated before the fetch fires (defense in depth;
//      the import constant is wire-stable, but a future caller could pass
//      a different name; reject anything outside the strict regex).
//   3. The cache key is the secret name; the cached value is never echoed
//      via toString, structured-clone, or any structured-log call.
//
// Why a separate module from `metadata-fetcher.ts`: the existing fetcher
// is the boot-time provider-token loader (60-second TTL aligned with the
// Phase C rotation contract). This Phase 10 fetcher serves the EmailTool
// at every send (not boot), with a different TTL aligned with Resend
// rotation. Sharing the type would couple two unrelated lifecycles, so the
// modules stay parallel.

import { RESEND_API_KEY_SECRET_NAME } from "../config/secret-names.ts";

export const RESEND_KEY_CACHE_TTL_MS = 15 * 60 * 1000;

const VALID_SECRET_NAME = /^[a-z_][a-z0-9_]*$/;

const DEFAULT_METADATA_BASE_URL = "http://169.254.169.254";

/**
 * Structured error kinds the fetcher emits. The EmailTool maps these onto
 * the seven-kind taxonomy at the agent boundary; a fetcher consumer is
 * expected to discriminate on `kind` rather than parse `message`.
 *
 *   - `unavailable`: the gateway returned 404 (name not seeded), 5xx, or
 *     the network call threw. The tool maps this to `key_unavailable`.
 *   - `auth_failed`: a previous send returned 401 from Resend. The fetcher
 *     invalidated the cache and a refetch also produced 401 from the
 *     gateway, OR the operator never seeded a fresh key. The tool maps
 *     this to `auth_failed`.
 *   - `invalid_name`: the caller passed a name outside the allowlist
 *     regex. Programmer error; should never happen in production because
 *     the only callsite imports the wire-stable constant. Surfaces as
 *     `key_unavailable` to the agent.
 */
export type KeyFetchError = {
	kind: "unavailable" | "auth_failed" | "invalid_name";
	message: string;
};

export type KeyFetchResult = { ok: true; value: string } | { ok: false; error: KeyFetchError };

/**
 * Public interface. The EmailTool depends on this shape so tests can
 * substitute a mock without spinning up a fetch double.
 */
export interface KeyFetcher {
	/** Returns the cached key OR fetches a fresh one. */
	get(): Promise<KeyFetchResult>;
	/**
	 * Invalidate the cache. Called by the EmailTool on a Resend 401 so
	 * the next get() refetches from the gateway. Idempotent.
	 */
	invalidate(): void;
}

type CacheEntry = {
	value: string;
	fetchedAt: number;
};

/**
 * Concrete fetcher backed by the in-VM metadata gateway. Tests override the
 * `now` and `fetchImpl` deps to deterministically exercise cache TTL and
 * error paths without sleeping or hitting the network.
 */
export class ResendKeyFetcher implements KeyFetcher {
	private readonly baseUrl: string;
	private readonly secretName: string;
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly fetchImpl: typeof fetch;
	private cache: CacheEntry | null = null;

	constructor(opts?: {
		baseUrl?: string;
		secretName?: string;
		ttlMs?: number;
		now?: () => number;
		fetchImpl?: typeof fetch;
	}) {
		this.baseUrl = opts?.baseUrl ?? DEFAULT_METADATA_BASE_URL;
		this.secretName = opts?.secretName ?? RESEND_API_KEY_SECRET_NAME;
		this.ttlMs = opts?.ttlMs ?? RESEND_KEY_CACHE_TTL_MS;
		this.now = opts?.now ?? (() => Date.now());
		this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
	}

	async get(): Promise<KeyFetchResult> {
		// Defense-in-depth name check. The constant import is wire-stable, but
		// guard against a future caller smuggling path components into the URL.
		if (!VALID_SECRET_NAME.test(this.secretName)) {
			return {
				ok: false,
				error: { kind: "invalid_name", message: `invalid secret name: ${this.secretName}` },
			};
		}

		const cached = this.cache;
		if (cached && this.now() - cached.fetchedAt < this.ttlMs) {
			return { ok: true, value: cached.value };
		}

		return this.refetch();
	}

	invalidate(): void {
		this.cache = null;
	}

	private async refetch(): Promise<KeyFetchResult> {
		const url = `${this.baseUrl}/v1/secrets/${encodeURIComponent(this.secretName)}`;

		let res: Response;
		try {
			res = await this.fetchImpl(url, { method: "GET" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				error: {
					kind: "unavailable",
					message: `metadata gateway unreachable for ${this.secretName}: ${msg}`,
				},
			};
		}

		// 401 from the gateway means phantomd is rejecting the request itself
		// (operator-side bearer mis-config). 401 from Resend is detected by
		// the EmailTool, not here. The fetcher treats gateway-401 as auth_failed
		// so the tool surfaces it cleanly to the agent.
		if (res.status === 401) {
			this.cache = null;
			return {
				ok: false,
				error: {
					kind: "auth_failed",
					message: `metadata gateway rejected fetch for ${this.secretName}: HTTP 401`,
				},
			};
		}

		if (res.status === 404) {
			return {
				ok: false,
				error: {
					kind: "unavailable",
					message: `metadata gateway has no entry for ${this.secretName}: HTTP 404`,
				},
			};
		}

		if (res.status !== 200) {
			return {
				ok: false,
				error: {
					kind: "unavailable",
					message: `metadata gateway error for ${this.secretName}: HTTP ${res.status}`,
				},
			};
		}

		// Read body via text(); never log the body. The cache holds it for the
		// TTL window, scoped to this fetcher instance.
		let value: string;
		try {
			value = await res.text();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				error: {
					kind: "unavailable",
					message: `metadata gateway response read failed for ${this.secretName}: ${msg}`,
				},
			};
		}

		if (!value) {
			return {
				ok: false,
				error: {
					kind: "unavailable",
					message: `metadata gateway returned empty body for ${this.secretName}`,
				},
			};
		}

		this.cache = { value, fetchedAt: this.now() };
		return { ok: true, value };
	}
}

/**
 * Env-backed fetcher for local dev / OSS Docker where the metadata gateway
 * is unreachable. Reads `RESEND_API_KEY` from `process.env` on every call.
 * No cache (env doesn't change at runtime) and no rotation semantics; this
 * is explicitly the "I'm not on Phantom Cloud, I'm running locally" path.
 *
 * Production wiring in `src/index.ts` picks the gateway-backed fetcher
 * when the metadata gateway is configured (PHANTOM_TENANT_ID set by
 * firstboot is the proxy signal); otherwise this fallback is used.
 */
export class EnvKeyFetcher implements KeyFetcher {
	private readonly envName: string;

	constructor(envName = "RESEND_API_KEY") {
		this.envName = envName;
	}

	async get(): Promise<KeyFetchResult> {
		const value = process.env[this.envName];
		if (!value) {
			return {
				ok: false,
				error: {
					kind: "unavailable",
					message: `env ${this.envName} not set`,
				},
			};
		}
		return { ok: true, value };
	}

	invalidate(): void {
		/* env-backed fetcher has no cache; rotation requires process restart */
	}
}
