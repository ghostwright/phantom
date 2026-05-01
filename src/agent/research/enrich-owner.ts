// Phase 12 user research first-pass.
//
// Runs at firstboot, BEFORE the intro DM is composed. Pulls public,
// anonymously-reachable signals about the agent's owner so the intro DM
// can open with a short, honest "what I learned about you" instead of a
// generic greeting. Architectural invariants (master plan section 3
// Phase 12, builder brief 2026-05-01-phase12-user-research-builder.md):
//
//   1. Public sources only. NO authenticated API calls. NO LinkedIn ToS
//      violations. We fetch the LinkedIn public profile page anonymously
//      and read whatever og: tags it serves; if LinkedIn refuses (HTTP
//      999, 403, login redirect), we move on.
//   2. Time-bounded to RESEARCH_BUDGET_MS (~15s). The intro DM cannot
//      block firstboot for minutes. If the budget elapses, we return
//      whatever we have so far.
//   3. Plaintext discipline. We never log the owner email at any level.
//      The bullets render the owner's NAME at most; the email stays in
//      env vars / SQLite.
//   4. Don't fabricate. If every probe is empty, return null bullets so
//      the intro DM degrades cleanly to today's no-research copy.
//
// Why this lives in src/agent/research/ and not src/onboarding/: the
// research output is also injected into the agent's system-prompt overlay
// (Phase 9 self-knowledge plus a "What I learned about my owner" block).
// Keeping it under src/agent/ makes that wiring obvious. The onboarding
// firstboot step is the FIRST consumer; the prompt overlay is the
// second.

import {
	type GithubProfile,
	type PageMetadata,
	fetchGithubProfile,
	fetchLinkedinPublic,
	fetchPageMetadata,
} from "./fetchers.ts";
import {
	MAX_BULLET_CHARS,
	type OwnerResearchInput,
	type OwnerResearchResult,
	RESEARCH_BUDGET_MS,
	type ResearchOutcome,
	type SourceRef,
} from "./types.ts";

export interface EnrichOwnerDeps {
	fetchImpl?: typeof fetch;
	/** Override the global research budget. Tests use this to assert
	 * the timeout path returns a partial result. */
	budgetMs?: number;
	/** Override the per-fetch timeout. Tests use this so they don't
	 * need to wait the full default. */
	perFetchTimeoutMs?: number;
	/** When true, the function returns immediately with an empty
	 * outcome="disabled" result. The firstboot caller toggles this off
	 * via PHANTOM_OWNER_RESEARCH_ENABLED=false (operator escape hatch). */
	disabled?: boolean;
	/** Injected clock for testing the timeout path. Defaults to Date.now. */
	now?: () => number;
}

export async function enrichOwner(input: OwnerResearchInput, deps: EnrichOwnerDeps = {}): Promise<OwnerResearchResult> {
	if (deps.disabled) {
		return { bullets: null, sources: [], outcome: "disabled" };
	}

	const email = input.email.trim();
	if (!email) {
		return { bullets: null, sources: [], outcome: "empty" };
	}

	const name = (input.name?.trim() || deriveNameFromEmail(email)).trim();
	const linkedinUrl = input.linkedinUrl?.trim();
	const personalSiteUrl = derivePersonalSiteUrl(email);
	const githubLogin = deriveGithubLogin(email, name);

	const budgetMs = deps.budgetMs ?? RESEARCH_BUDGET_MS;
	const now = deps.now ?? Date.now;
	const startedAt = now();
	const overall = AbortSignal.timeout(budgetMs);

	const fetchDeps = {
		fetchImpl: deps.fetchImpl,
		timeoutMs: deps.perFetchTimeoutMs,
		signal: overall,
	};

	// Run all probes in parallel. Each tolerates network failure and
	// returns null on its own; the global AbortSignal cancels them all
	// when the budget elapses.
	const [githubResult, siteResult, linkedinResult] = await Promise.all([
		githubLogin ? safeProbe(() => fetchGithubProfile(githubLogin, fetchDeps)) : Promise.resolve(null),
		personalSiteUrl ? safeProbe(() => fetchPageMetadata(personalSiteUrl, fetchDeps)) : Promise.resolve(null),
		linkedinUrl ? safeProbe(() => fetchLinkedinPublic(linkedinUrl, fetchDeps)) : Promise.resolve(null),
	]);

	const elapsed = now() - startedAt;
	const timedOut = elapsed >= budgetMs;

	const bullets: string[] = [];
	const sources: SourceRef[] = [];

	const githubBullet = composeGithubBullet(githubResult, name);
	if (githubBullet && githubResult) {
		bullets.push(githubBullet);
		sources.push({ kind: "github", url: githubResult.html_url });
	}

	const linkedinBullet = composeLinkedinBullet(linkedinResult);
	if (linkedinBullet && linkedinResult) {
		bullets.push(linkedinBullet);
		sources.push({ kind: "linkedin_public", url: linkedinResult.url });
	}

	const siteBullet = composeSiteBullet(siteResult, name);
	if (siteBullet && siteResult) {
		bullets.push(siteBullet);
		sources.push({ kind: "personal_site", url: siteResult.url });
	}

	// Cap at 3 bullets; pick the first three that survived the probes.
	const finalBullets = bullets.slice(0, 3);
	const finalSources = sources.slice(0, 3);

	if (finalBullets.length === 0) {
		const outcome: ResearchOutcome = timedOut ? "timeout" : "empty";
		return { bullets: null, sources: [], outcome };
	}

	return {
		bullets: finalBullets,
		sources: finalSources,
		outcome: timedOut ? "timeout" : "ok",
	};
}

async function safeProbe<T>(probe: () => Promise<T | null>): Promise<T | null> {
	try {
		return await probe();
	} catch {
		return null;
	}
}

// Derive a likely GitHub login from email or name. We try the local-part
// of the email first (the most common pattern: matt@example.com -> "matt"),
// then the name with whitespace removed. The fetcher rejects malformed
// logins so this is allowed to be slightly optimistic.
function deriveGithubLogin(email: string, name: string): string | null {
	const localPart = email.split("@")[0]?.trim();
	if (localPart && /^[a-zA-Z0-9-]{1,39}$/.test(localPart)) {
		return localPart;
	}
	if (name) {
		const compact = name.replace(/\s+/g, "").trim();
		if (compact && /^[a-zA-Z0-9-]{1,39}$/.test(compact)) {
			return compact;
		}
	}
	return null;
}

// Derive a personal-site URL from the email domain. We skip well-known
// mailbox providers (gmail, outlook, etc.) because their domain is not
// the user's site. For everything else we try https://<domain>.
function derivePersonalSiteUrl(email: string): string | null {
	const domain = email.split("@")[1]?.trim().toLowerCase();
	if (!domain) return null;
	if (PUBLIC_MAILBOX_DOMAINS.has(domain)) return null;
	if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
	return `https://${domain}`;
}

// Derive a fallback name from the email local-part when PHANTOM_OWNER_NAME
// is unset. "matt.j@x.com" -> "matt.j" stays as a single token; we do not
// try to pretty-print here because that easily fabricates ("matt j" is not
// the same person as "matt-j" or "mattj").
function deriveNameFromEmail(email: string): string {
	const local = email.split("@")[0] ?? "";
	return local;
}

function composeGithubBullet(profile: GithubProfile | null, _name: string): string | null {
	if (!profile) return null;
	// Prefer bio when present (it is the user's own self-description).
	// Fall back to a structural summary built from name + company +
	// public-repo count. We never fabricate; if all signals are null,
	// return null and let the caller drop the bullet.
	if (profile.bio) {
		return cap(`On GitHub as @${profile.login}: ${profile.bio}`);
	}
	const facts: string[] = [];
	if (profile.name) facts.push(profile.name);
	if (profile.company) facts.push(`at ${profile.company}`);
	if (profile.public_repos > 0) facts.push(`${profile.public_repos} public repos`);
	if (facts.length === 0) return null;
	return cap(`On GitHub as @${profile.login}: ${facts.join(", ")}.`);
}

function composeLinkedinBullet(meta: PageMetadata | null): string | null {
	if (!meta) return null;
	// LinkedIn's og:title is usually "FirstName LastName - Headline | LinkedIn".
	// The headline is the most useful signal; if the title carries a hyphen
	// we keep what comes after it. og:description tends to be a short bio.
	const headline = parseLinkedinHeadline(meta.title);
	if (headline) {
		return cap(`LinkedIn headline: ${headline}.`);
	}
	if (meta.description) {
		return cap(`LinkedIn says: ${meta.description}`);
	}
	return null;
}

function composeSiteBullet(meta: PageMetadata | null, name: string): string | null {
	if (!meta) return null;
	// Prefer description (richer). Title is often just the site name and
	// adds little signal. If both exist we combine them; if only title
	// exists we drop it (a site title alone is usually noise like "Home").
	if (meta.description) {
		const stem = meta.title ? `${meta.title}: ${meta.description}` : meta.description;
		return cap(`Their site at ${shortHost(meta.url)}: ${stem}`);
	}
	if (meta.title && !looksLikeGenericSiteTitle(meta.title, name)) {
		return cap(`Their site at ${shortHost(meta.url)}: ${meta.title}.`);
	}
	return null;
}

function parseLinkedinHeadline(title: string | null): string | null {
	if (!title) return null;
	// Strip trailing "| LinkedIn" decoration.
	const stripped = title.replace(/\s*[|-]\s*linkedin\s*$/i, "").trim();
	if (!stripped) return null;
	// "Name - Headline" pattern: keep the headline.
	const dashSplit = stripped.split(/\s+[-]\s+/);
	if (dashSplit.length >= 2) {
		const tail = dashSplit.slice(1).join(" - ").trim();
		return tail.length > 0 ? tail : null;
	}
	return stripped;
}

function looksLikeGenericSiteTitle(title: string, name: string): boolean {
	const lower = title.toLowerCase().trim();
	if (["home", "welcome", "index", "untitled"].includes(lower)) return true;
	if (name && lower === name.toLowerCase().trim()) return true;
	return false;
}

function shortHost(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function cap(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= MAX_BULLET_CHARS) return collapsed;
	return `${collapsed.slice(0, MAX_BULLET_CHARS - 1)}…`;
}

// Major public mailbox providers we never treat as the user's personal
// site. Lowercase, no subdomain. Keep this list tight: false positives
// here just mean we skip a probe, false negatives mean we waste budget.
const PUBLIC_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
	"gmail.com",
	"googlemail.com",
	"yahoo.com",
	"yahoo.co.uk",
	"outlook.com",
	"hotmail.com",
	"live.com",
	"icloud.com",
	"me.com",
	"mac.com",
	"protonmail.com",
	"proton.me",
	"pm.me",
	"aol.com",
	"msn.com",
	"fastmail.com",
	"hey.com",
	"zoho.com",
	"yandex.com",
	"yandex.ru",
	"mail.com",
	"gmx.com",
	"gmx.de",
	"web.de",
	"qq.com",
	"163.com",
	"126.com",
	"naver.com",
	"daum.net",
]);
