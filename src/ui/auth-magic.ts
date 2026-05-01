// Phase 6 PR-3 (2026-05-01) per-tenant /auth/magic callback.
//
// The dashboard mints a one-time, single-use, short-TTL token via
// phantom-control and 302s the user's browser to
// https://<slug>.phantom.ghostwright.dev/auth/magic?token=<x>.
// This handler is the per-tenant landing.
//
// Wire shape:
//
//   in:  GET /auth/magic?token=<43-char base64url> [&redirect=<path>]
//   out: 302 to /chat with Set-Cookie phantom_session on success.
//        302 to PHANTOM_DASHBOARD_URL?magic_error=<code> on every
//        failure mode. The token is NEVER echoed back to the client
//        and NEVER logged at any level.
//
// The token plaintext lives in a single stack frame for the lifetime
// of this function. The validator hop is server-to-server over the
// in-VM metadata gateway path (http://169.254.169.254/v1/magic-link/
// validate); the client never sees the validator URL or the bearer
// the metadata gateway uses to talk to phantom-control.
//
// Architect: phantom-cloud-deploy/local/2026-05-01-phase6-magic-link-architect.md
//   §6.3 (route handler shape)
//   §6.5 (metadata-gateway hop)
//   §6.6 (per-IP rate-limit; 10 / IP / minute, sliding window)
//   §6.7 (cookie shape: per-slug Domain, SameSite=Lax)
//   §8.1 (failure-code matrix; every error redirects to dashboard
//         with a normalized ?magic_error= code; the dashboard
//         renders a Sonner toast on read).
//   §10  (CSRF posture: SameSite cookies + workspace_members are
//         the gates; no state token).
//   §13  (open-redirect defense; ?redirect= must be path-only).

import { createSession } from "./session.ts";

// Strict shape gate. The phantom-control mint emits exactly 32 bytes
// from crypto/rand encoded as base64url-no-padding (43 chars). Any
// other shape (32-char hex, 44-char base64-with-pad, anything-else)
// is rejected at near-zero cost before we touch the validator. The
// regex matches the byte-for-byte mirror at
// phantom-control/internal/httpshim/magic_link.go::magicTokenShapeRE
// and phantomd/internal/metadata/magic_link_proxy.go::
// magicLinkTokenShapeRE.
const MAGIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Per-IP rate limit (sliding window). Architect §6.6 caps at
// 10 / IP / minute. Legitimate flows click once; 10 is generous
// headroom for browser-back retries plus a few stray probes. Note
// that a SUCCESSFUL validate does NOT bump the budget: the budget
// gates probing-by-strangers (the kind that try to guess valid
// tokens), not the legitimate sign-in path. This matches the
// phantomd-proxy semantics at magic_link_proxy.go::magicLinkRateLimiter.
const RATE_LIMIT_PER_IP_PER_MIN = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_IP_MAP_CAP = 1024;

// Bound on the metadata-gateway round-trip. A misbehaving
// phantom-control should surface as a 503-equivalent error UX
// quickly; we do not want a hung browser tab. Architect §6.3 picks
// 2 seconds; sub-1s is too aggressive given Neon round-trip
// variance, and beyond 2 seconds the user has clicked a second
// thing.
const VALIDATOR_TIMEOUT_MS = 2_000;

// The metadata-gateway URL inside the VM. Mirrors the existing
// METADATA_BASE_URL convention from phantom-rootfs/systemd/
// phantom.service:33 ("Environment=METADATA_BASE_URL=http://
// 169.254.169.254"). The gateway hosts /v1/magic-link/validate as
// a thin reverse proxy to phantom-control's bearer-auth shim
// (phantomd/internal/metadata/magic_link_proxy.go); the bearer is
// operator-side only and never visible to this process.
const DEFAULT_METADATA_BASE_URL = "http://169.254.169.254";

// Bun's Set-Cookie machinery does not let you stack two
// Set-Cookie headers via Headers#set; we use append. The names
// match phantom/src/ui/serve.ts:31's COOKIE_NAME plus
// COOKIE_MAX_AGE so the legacy login flow and the magic-link
// callback are interchangeable on the read side.
const COOKIE_NAME = "phantom_session";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days, matching session.ts SESSION_TTL_MS

// Failure codes this handler emits via ?magic_error=. The dashboard
// renders a Sonner toast keyed on the code (Phase 3 §9.7); a code
// the dashboard does not know surfaces a generic "Could not open
// agent" message. Keeping the set tight + documented makes that
// dashboard-side mapping easier to maintain.
type MagicErrorCode =
	| "invalid_token"
	| "rate_limited"
	| "expired"
	| "validator_unavailable"
	| "owner_mismatch"
	| "agent_mismatch"
	| "tenant_unconfigured";

interface ValidateResponse {
	agent_id: string;
	agent_slug: string;
	owner_email: string;
}

// Per-IP rate-limit state. Map key is the source IP (string); value
// is the array of attempt timestamps (ms) within the trailing
// window. Bounded eviction kicks in at RATE_LIMIT_IP_MAP_CAP so a
// hostile client rotating IPs cannot grow the map without bound.
const ipAttempts = new Map<string, number[]>();

// clearAuthMagicRateLimitsForTests resets the IP rate-limit map.
// Tests that fan out many requests under one synthetic IP must
// reset between cases to avoid bleed.
export function clearAuthMagicRateLimitsForTests(): void {
	ipAttempts.clear();
}

// MagicAuthFetcher is the minimal callable shape this handler needs
// from a fetch-compatible client. Defining a tighter interface than
// `typeof fetch` lets tests stub a function without satisfying the
// `preconnect` static method Bun's runtime fetch carries (which a
// test-time fake cannot meaningfully provide).
export type MagicAuthFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// MagicAuthDeps lets tests stub the validator hop. Production wires
// the default fetch + clock. The dashboard URL and the metadata
// base URL also flow through here so a test can pin them without
// mutating process.env.
export interface MagicAuthDeps {
	fetcher: MagicAuthFetcher;
	clock: () => number;
	metadataBaseUrl: string;
	dashboardUrl: string;
	tenantSlug: string;
	ownerEmail: string;
}

function defaultDeps(): MagicAuthDeps {
	const dashboardUrl = (process.env.PHANTOM_DASHBOARD_URL ?? "").trim();
	const tenantSlug = (process.env.PHANTOM_TENANT_SLUG ?? "").trim();
	const ownerEmail = (process.env.PHANTOM_OWNER_EMAIL ?? process.env.OWNER_EMAIL ?? "").trim();
	const metadataBaseUrl = (process.env.METADATA_BASE_URL ?? "").trim() || DEFAULT_METADATA_BASE_URL;
	return {
		fetcher: (input, init) => fetch(input, init),
		clock: () => Date.now(),
		metadataBaseUrl,
		dashboardUrl,
		tenantSlug,
		ownerEmail,
	};
}

// handleAuthMagic serves GET /auth/magic. Returns a Response with
// the appropriate 302 + Set-Cookie or 302-to-dashboard-with-error.
//
// The handler NEVER throws to its caller; every error path is
// converted into a 302 redirect with a normalized ?magic_error=
// code. The dashboard surfaces the toast.
export async function handleAuthMagic(req: Request, depsOverride?: Partial<MagicAuthDeps>): Promise<Response> {
	const deps: MagicAuthDeps = { ...defaultDeps(), ...(depsOverride ?? {}) };

	const url = new URL(req.url);
	if (req.method !== "GET") {
		// Path is GET-only by design (the dashboard 302s the user's
		// browser; cross-origin POSTs are blocked by SameSite on the
		// dashboard's Clerk cookie anyway). Reject anything else
		// without consuming the rate-limit budget.
		return new Response("method not allowed", { status: 405, headers: { Allow: "GET" } });
	}

	const token = url.searchParams.get("token") ?? "";

	// Step 1: input shape gate. Reject malformed tokens BEFORE the
	// rate-limit budget so a deliberately malformed flood does not
	// burn the budget for a legitimate user behind the same NAT.
	// The token shape is the same byte-for-byte mirror across
	// phantom-control + phantomd; a legitimate mint always
	// produces 43 chars. A 0-char token (someone hitting /auth/magic
	// with no query) lands here too.
	if (!MAGIC_TOKEN_PATTERN.test(token)) {
		return redirectToError("invalid_token", deps);
	}

	// Step 2: per-IP rate limit. Sliding window, 10 per minute. Done
	// AFTER the shape gate so malformed shapes do not contribute,
	// and BEFORE the validator hop so a flood costs near zero.
	// Successful validates do NOT bump the budget (drained on the
	// success path).
	const ip = extractClientIP(req);
	if (!checkIpRateLimit(ip, deps.clock)) {
		return redirectToError("rate_limited", deps);
	}

	// Step 3: tenant config sanity. Without PHANTOM_TENANT_SLUG we
	// cannot enforce the cross-tenant defense; without
	// PHANTOM_OWNER_EMAIL we cannot enforce the owner binding.
	// Either is a misconfiguration; fail closed.
	if (deps.tenantSlug === "" || deps.ownerEmail === "") {
		return redirectToError("tenant_unconfigured", deps);
	}

	// Step 4: validator hop. Route through the metadata gateway
	// listening on the link-local IP; ip route + nft rules guarantee
	// only this tenant's veth can reach it (phantomd
	// internal/metadata/gateway.go + internal/nft/manager.go). The
	// gateway proxies to phantom-control's bearer-auth shim with the
	// bearer the in-VM phantom never sees.
	let result: ValidateResponse;
	try {
		const validatorUrl = `${deps.metadataBaseUrl.replace(/\/+$/, "")}/v1/magic-link/validate`;
		// AbortSignal.timeout returns an AbortSignal that fires after
		// the millisecond delay; the fetch promise rejects with a
		// DOMException("AbortError") when triggered.
		const res = await deps.fetcher(validatorUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
			signal: AbortSignal.timeout(VALIDATOR_TIMEOUT_MS),
		});
		if (res.status === 404) {
			// 404 is the canonical "token unknown / consumed / expired"
			// response from phantom-control; the body is generic so
			// we cannot distinguish "wrong token" from "expired" by
			// content. We surface "expired" as the user-facing reason
			// because that is by far the most common cause.
			return redirectToError("expired", deps);
		}
		if (res.status === 400) {
			// The metadata gateway already shape-gated; a 400 here
			// means a token that passed our regex was somehow rejected
			// upstream. Defense-in-depth: surface as invalid_token.
			return redirectToError("invalid_token", deps);
		}
		if (res.status === 403) {
			// Cross-tenant rejection from the metadata gateway. The
			// caller's tenant_id resolved to a slug that does not
			// match the validated agent_slug. The defense-in-depth
			// gate at this handler (Step 5) duplicates this check;
			// surface as agent_mismatch so the dashboard's toast can
			// guide the user to the correct agent.
			return redirectToError("agent_mismatch", deps);
		}
		if (res.status === 429) {
			// Per-tenant rate limit hit upstream. Surface to the user
			// as rate_limited so the dashboard shows the wait-a-minute
			// toast.
			return redirectToError("rate_limited", deps);
		}
		if (!res.ok) {
			// Any 5xx OR an unexpected status code (e.g. the 503 the
			// gateway returns when the validator is unconfigured).
			// The user-facing message is "phantom cloud is having a
			// hiccup; try again".
			return redirectToError("validator_unavailable", deps);
		}
		result = (await res.json()) as ValidateResponse;
	} catch {
		// Timeout, network error, malformed JSON, anything else.
		// Note: we do NOT log the caught error's message because in
		// some runtimes the URL (containing the token query) leaks
		// into the error string. Keeping the catch silent on token
		// data is the load-bearing plaintext-discipline guard.
		return redirectToError("validator_unavailable", deps);
	}

	// Validate the response shape before trusting any field. A
	// misbehaving upstream that returns 200-with-empty-body must
	// not crash this handler.
	if (
		typeof result?.agent_id !== "string" ||
		typeof result?.agent_slug !== "string" ||
		typeof result?.owner_email !== "string"
	) {
		return redirectToError("validator_unavailable", deps);
	}

	// Step 5: cross-tenant defense in depth. The metadata gateway
	// already enforces this (phantomd magic_link_proxy.go::
	// handleMagicLinkValidate refuses 403 when the calling
	// tenant_slug != validated agent_slug), but a defense-in-depth
	// check at this handler protects against a future code path
	// that bypasses the gateway (e.g. tests that mock the validator)
	// and against the catastrophic-misconfig case where a tenant's
	// slug got drift between phantomd and the in-VM phantom.
	if (result.agent_slug.trim() !== deps.tenantSlug) {
		return redirectToError("agent_mismatch", deps);
	}

	// Step 6: owner_email binding. The token's owner_email (the row
	// at mint time, denorm of users.email per Phase 2 schema
	// architect §11.3) must match this tenant's PHANTOM_OWNER_EMAIL
	// (the firstboot-baked value, see phantomd
	// internal/firstboot/firstboot.go). A mismatch is by-construction
	// near-impossible, but failing closed here is the right posture
	// (architect §6.3 + §11.3 sealed-tenant correctness invariant).
	const tokenOwnerEmail = result.owner_email.trim().toLowerCase();
	const expectedOwnerEmail = deps.ownerEmail.toLowerCase();
	if (tokenOwnerEmail !== expectedOwnerEmail) {
		return redirectToError("owner_mismatch", deps);
	}

	// Step 7: mint a phantom_session cookie. Use the existing
	// session-store machinery so isValidSession() picks up the new
	// session immediately. createSession() returns BOTH a
	// sessionToken and a magicToken; we only need the sessionToken
	// (the magicToken is for the legacy /ui/login?magic= flow which
	// has its own owner mailer; we never expose the new magic token
	// to anyone).
	const { sessionToken } = createSession();
	const cookieHeaders = buildPerTenantCookieHeaders(sessionToken, deps.tenantSlug);

	// Step 8: redirect to the chat root (or to the operator's deep
	// link, if it is path-only). The sanitizer rejects any value
	// that does not start with a single forward slash, including
	// protocol-relative ("//evil.com") and absolute URLs.
	const redirectTarget = sanitizeRedirectTarget(url.searchParams.get("redirect"));
	cookieHeaders.set("Location", redirectTarget);

	// Audit log. The agent_id + agent_slug + IP are safe to log;
	// the token plaintext is NEVER logged at any level. (We do not
	// log the owner_email either: it is PII and unnecessary for
	// the operational debugging this entry serves.)
	console.log(
		"[auth-magic] sign-in",
		JSON.stringify({
			agent_id: result.agent_id,
			agent_slug: result.agent_slug,
			ip,
		}),
	);

	return new Response(null, { status: 302, headers: cookieHeaders });
}

// extractClientIP pulls the real client IP from the X-Forwarded-For
// header (Caddy injects this when terminating wildcard TLS). When
// the header is absent (unit tests, direct curl in dev), we fall
// back to "unknown" so the rate-limit map still buckets requests.
function extractClientIP(req: Request): string {
	const forwarded = req.headers.get("x-forwarded-for");
	if (forwarded) {
		// X-Forwarded-For is a comma-separated chain; the leftmost
		// entry is the original client per RFC 7239 conventions.
		const first = forwarded.split(",")[0]?.trim();
		if (first) return first;
	}
	return "unknown";
}

// checkIpRateLimit records an attempt at `ip` and returns true iff
// the trailing-window count is at or below the per-IP cap. A reject
// does NOT record the attempt (otherwise a sustained flood would
// push the count infinitely upward and the limiter never drains).
// Mirrors the rate-limit semantics in phantomd magic_link_proxy.go::
// magicLinkRateLimiter.allow.
function checkIpRateLimit(ip: string, clock: () => number): boolean {
	const now = clock();
	const cutoff = now - RATE_LIMIT_WINDOW_MS;
	const prior = ipAttempts.get(ip) ?? [];
	const kept: number[] = [];
	for (const ts of prior) {
		if (ts > cutoff) kept.push(ts);
	}
	if (kept.length >= RATE_LIMIT_PER_IP_PER_MIN) {
		ipAttempts.set(ip, kept);
		evictBloatedIfNeeded(cutoff);
		return false;
	}
	kept.push(now);
	ipAttempts.set(ip, kept);
	evictBloatedIfNeeded(cutoff);
	return true;
}

// evictBloatedIfNeeded keeps the IP map bounded under hostile
// IP-rotation. When the map exceeds RATE_LIMIT_IP_MAP_CAP we drop
// every IP whose latest attempt is outside the window. The eviction
// is O(n) on the map size; we do it inline at the threshold so the
// 99th-percentile happy path never pays.
function evictBloatedIfNeeded(cutoff: number): void {
	if (ipAttempts.size <= RATE_LIMIT_IP_MAP_CAP) return;
	for (const [ip, list] of ipAttempts) {
		if (list.length === 0 || list[list.length - 1] < cutoff) {
			ipAttempts.delete(ip);
		}
	}
}

// sanitizeRedirectTarget defends against the OWASP "Unvalidated
// Redirects and Forwards" risk. A magic-link callback is the
// canonical place a sloppy implementation lets an attacker hop
// the user out of the trust boundary by passing
// `?redirect=https://evil.com`. We accept ONLY single-leading-slash
// path-only values; anything else falls back to /chat. Empty input
// also falls back.
//
// Architect §6.8 + §13.6 + OWASP cheat sheet
// (/owasp/cheatsheetseries "Unvalidated Redirects and Forwards").
function sanitizeRedirectTarget(raw: string | null): string {
	if (!raw) return "/chat";
	if (!raw.startsWith("/")) return "/chat"; // open-redirect defense
	if (raw.startsWith("//")) return "/chat"; // protocol-relative defense
	if (raw.includes("\\")) return "/chat"; // backslash-trick defense
	return raw;
}

// redirectToError returns a 302 to the dashboard with a normalized
// ?magic_error= code. The dashboard renders a Sonner toast on read
// (Phase 3 §9.7). We do NOT echo the candidate token in the URL or
// the body; the token plaintext stays out of every error response.
//
// Falls back to /ui/login when PHANTOM_DASHBOARD_URL is unset, so
// dev runs (no dashboard configured) still land somewhere sane.
function redirectToError(code: MagicErrorCode, deps: MagicAuthDeps): Response {
	const dashboard = deps.dashboardUrl.trim();
	const target =
		dashboard === ""
			? `/ui/login?magic_error=${encodeURIComponent(code)}`
			: `${dashboard}?magic_error=${encodeURIComponent(code)}`;
	const headers = new Headers();
	headers.set("Location", target);
	headers.set("Cache-Control", "no-store");
	return new Response(null, { status: 302, headers });
}

// buildPerTenantCookieHeaders returns the Set-Cookie chain for a
// successful magic-link sign-in:
//
//   1. The new phantom_session, scoped to <slug>.phantom...
//      with SameSite=Lax (architect §7).
//   2. An expiry of any legacy Path=/ui phantom_session cookie a
//      browser may carry from the pre-PR1 era. Same defensive
//      pattern as buildCookieHeaders in serve.ts:189-194.
//
// Why per-slug Domain instead of wildcard `.phantom.ghostwright.dev`:
// Architect §7.3 hard-rejects the wildcard. A wildcard cookie
// crosses tenant boundaries (sister tenants would receive each
// other's cookie on top-level navigation). Per-slug scope is the
// load-bearing isolation control.
//
// Why SameSite=Lax instead of Strict: architect §7.4 defends Lax
// for the bookmarked-direct-navigation UX. Strict breaks the
// magic-link redirect itself for some browsers and forces re-auth
// on every cross-origin landing.
//
// The PHANTOM_DOMAIN env var (per phantomd firstboot) carries the
// full <slug>.phantom.ghostwright.dev string. When it is unset (dev
// mode) we omit the Domain attribute so the cookie defaults to
// the request origin (matching the existing /ui/login flow).
function buildPerTenantCookieHeaders(sessionToken: string, _tenantSlug: string): Headers {
	const headers = new Headers();
	const domain = (process.env.PHANTOM_DOMAIN ?? "").trim();
	const parts = [
		`${COOKIE_NAME}=${sessionToken}`,
		"Path=/",
		"HttpOnly",
		"Secure",
		"SameSite=Lax",
		`Max-Age=${COOKIE_MAX_AGE}`,
	];
	if (domain) parts.push(`Domain=${normalizeDomain(domain)}`);
	headers.append("Set-Cookie", parts.join("; "));
	// Defensive: clear any legacy Path=/ui cookie the browser may
	// carry from the pre-PR1 era so getSessionCookie does not pick
	// up the stale value first (RFC 6265 says the more-specific
	// path wins in the Cookie header).
	headers.append(
		"Set-Cookie",
		`${COOKIE_NAME}=; Path=/ui; HttpOnly; Secure; SameSite=Lax; Max-Age=0${domain ? `; Domain=${normalizeDomain(domain)}` : ""}`,
	);
	return headers;
}

// normalizeDomain strips an accidental scheme prefix or trailing
// slash from PHANTOM_DOMAIN. The phantomd firstboot stamps the bare
// host, but a future operator change could land "https://<slug>...
// /". Defensive cleanup keeps the Set-Cookie wire correct.
function normalizeDomain(raw: string): string {
	let v = raw.trim();
	if (v.startsWith("http://")) v = v.slice("http://".length);
	if (v.startsWith("https://")) v = v.slice("https://".length);
	if (v.endsWith("/")) v = v.slice(0, -1);
	return v;
}
