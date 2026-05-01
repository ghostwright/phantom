// Phase 12: lightweight HTTP fetchers for public sources.
//
// We deliberately avoid pulling in puppeteer/playwright for this path.
// The intro DM enrichment is a 15-second one-shot; it cannot afford a
// browser launch. Plain fetch + regex pulls the og: tags and the GitHub
// public profile JSON cheaply.
//
// Every fetcher is allowlist-aware in its caller (probe.ts decides which
// hosts to hit based on the input). Every fetch carries an explicit
// AbortSignal so a slow source does not eat the global budget.

import { PER_FETCH_TIMEOUT_MS } from "./types.ts";

const USER_AGENT = "phantom-research-firstboot/1.0 (+https://ghostwright.dev)";

/** GitHub public user profile shape (subset we actually use). */
export interface GithubProfile {
	login: string;
	name: string | null;
	bio: string | null;
	company: string | null;
	location: string | null;
	blog: string | null;
	public_repos: number;
	followers: number;
	html_url: string;
}

/** Minimal og:/twitter: meta tags pulled from a personal site index. */
export interface PageMetadata {
	title: string | null;
	description: string | null;
	url: string;
}

export interface FetchDeps {
	/** Defaults to global fetch. Tests inject a deterministic stub. */
	fetchImpl?: typeof fetch;
	/** Extra ms to allow per fetch. Defaults to PER_FETCH_TIMEOUT_MS. */
	timeoutMs?: number;
	/** External AbortSignal; if it fires, the fetch is cancelled. */
	signal?: AbortSignal;
}

/**
 * Look up a GitHub user by login. Public REST API, no auth required.
 * Returns null on 404, network error, or non-200 responses. The fetcher
 * does NOT retry; the caller manages parallelism + the global budget.
 */
export async function fetchGithubProfile(login: string, deps: FetchDeps = {}): Promise<GithubProfile | null> {
	const trimmed = login.trim();
	if (!trimmed) return null;
	if (!isLikelyGithubLogin(trimmed)) return null;

	const url = `https://api.github.com/users/${encodeURIComponent(trimmed)}`;
	const res = await safeFetch(url, deps);
	if (!res || !res.ok) return null;

	try {
		const body = (await res.json()) as Partial<GithubProfile>;
		if (!body || typeof body.login !== "string") return null;
		// Defensive cleaning: GitHub returns empty strings for unset fields,
		// we normalize to null so the bullet builder can use boolean checks.
		return {
			login: body.login,
			name: nonEmpty(body.name),
			bio: nonEmpty(body.bio),
			company: nonEmpty(body.company),
			location: nonEmpty(body.location),
			blog: nonEmpty(body.blog),
			public_repos: typeof body.public_repos === "number" ? body.public_repos : 0,
			followers: typeof body.followers === "number" ? body.followers : 0,
			html_url: body.html_url ?? `https://github.com/${trimmed}`,
		};
	} catch {
		return null;
	}
}

/**
 * Fetch a page and pull og:title, og:description, twitter:title,
 * twitter:description, and the <title> tag. We deliberately skip
 * authenticated content; only public, anonymously-reachable pages are
 * useful here.
 */
export async function fetchPageMetadata(url: string, deps: FetchDeps = {}): Promise<PageMetadata | null> {
	const trimmed = url.trim();
	if (!trimmed) return null;
	if (!isHttpUrl(trimmed)) return null;

	const res = await safeFetch(trimmed, deps);
	if (!res || !res.ok) return null;

	const contentType = res.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("text/html")) return null;

	let body: string;
	try {
		body = await res.text();
	} catch {
		return null;
	}

	// Cap parsing at 256KB; real og: tags live in the first 16KB. This
	// also defeats memory-blowup pages that ship multi-MB index.html.
	const head = body.slice(0, 256 * 1024);

	// og: lives on `property=`, twitter: lives on `name=` per OpenGraph + Twitter conventions.
	const title = extractMeta(head, "og:title") ?? extractMetaName(head, "twitter:title") ?? extractTitleTag(head);
	const description =
		extractMeta(head, "og:description") ??
		extractMetaName(head, "twitter:description") ??
		extractMetaName(head, "description");

	if (!title && !description) return null;

	return {
		title: nonEmpty(title),
		description: nonEmpty(description),
		url: res.url || trimmed,
	};
}

/**
 * LinkedIn public profile fetch. LinkedIn aggressively gates anonymous
 * traffic (HTTP 999, 403, redirects to login) so this fetch fails far
 * more often than it succeeds, and that is fine. We never try to
 * authenticate, never use a scraping service, never bypass the gate.
 * When LinkedIn answers, we extract og:title + og:description like any
 * other page.
 */
export async function fetchLinkedinPublic(url: string, deps: FetchDeps = {}): Promise<PageMetadata | null> {
	const trimmed = url.trim();
	if (!trimmed) return null;
	if (!isLinkedinUrl(trimmed)) return null;
	return fetchPageMetadata(trimmed, deps);
}

// --- internals ---

async function safeFetch(url: string, deps: FetchDeps): Promise<Response | null> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const timeoutMs = deps.timeoutMs ?? PER_FETCH_TIMEOUT_MS;
	const controller = new AbortController();
	const externalSignal = deps.signal;
	const onAbort = () => controller.abort();
	if (externalSignal) {
		if (externalSignal.aborted) {
			controller.abort();
		} else {
			externalSignal.addEventListener("abort", onAbort, { once: true });
		}
	}
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetchImpl(url, {
			method: "GET",
			signal: controller.signal,
			headers: {
				"user-agent": USER_AGENT,
				accept: "application/json,text/html;q=0.9,*/*;q=0.5",
			},
			redirect: "follow",
		});
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
	}
}

function nonEmpty(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function isHttpUrl(value: string): boolean {
	try {
		const u = new URL(value);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

function isLinkedinUrl(value: string): boolean {
	if (!isHttpUrl(value)) return false;
	try {
		const host = new URL(value).hostname.toLowerCase();
		return host === "www.linkedin.com" || host === "linkedin.com";
	} catch {
		return false;
	}
}

// GitHub usernames: alphanumeric + single hyphens, 1-39 chars, no leading
// or trailing hyphen. We want to defeat malformed input and obvious URL
// fragments before we hit the GitHub API.
function isLikelyGithubLogin(value: string): boolean {
	if (value.length < 1 || value.length > 39) return false;
	return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?!-))*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/.test(value);
}

function extractMeta(html: string, property: string): string | null {
	// Match either order: property="..." content="..." or content="..." property="...".
	const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re1 = new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i");
	const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, "i");
	const match = html.match(re1) ?? html.match(re2);
	return match ? decodeHtml(match[1]) : null;
}

function extractMetaName(html: string, name: string): string | null {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re1 = new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i");
	const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["']`, "i");
	const match = html.match(re1) ?? html.match(re2);
	return match ? decodeHtml(match[1]) : null;
}

function extractTitleTag(html: string): string | null {
	const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return match ? decodeHtml(match[1].replace(/\s+/g, " ").trim()) : null;
}

function decodeHtml(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'");
}
