// Phase 12 user research first-pass: shared types.
//
// The research subroutine collects public-only signals about the agent's
// owner before the firstboot intro DM goes out. The output is a small,
// honest summary the agent can reference later. We never fabricate; if
// every probe comes back empty, we return null bullets and the intro DM
// renders without the "What I learned" section.

/** A single public-source citation supporting one bullet. */
export interface SourceRef {
	/** "github" | "personal_site" | "linkedin_public" | "domain_search" */
	kind: SourceKind;
	/** The URL the bullet was derived from. Used for transparency only;
	 * never echoed verbatim into the intro DM body unless the bullet text
	 * already mentions it. */
	url: string;
}

export type SourceKind = "github" | "personal_site" | "linkedin_public" | "domain_search";

/** Result of the owner-research run. Bullets is null when research found
 * nothing useful; we never invent placeholder copy. */
export interface OwnerResearchResult {
	/** Up to 3 short bullets, each <= 280 chars. null on empty research. */
	bullets: string[] | null;
	/** One SourceRef per bullet (parallel array). Empty when bullets is null. */
	sources: SourceRef[];
	/** Diagnostic outcome for the operator. Never user-facing. */
	outcome: ResearchOutcome;
}

export type ResearchOutcome = "ok" | "empty" | "timeout" | "disabled" | "error";

/** Inputs the firstboot path collects from env vars. linkedinUrl is
 * optional; the wizard collects it in Phase 1 once that PR lands. */
export interface OwnerResearchInput {
	/** PHANTOM_OWNER_EMAIL. Required. */
	email: string;
	/** PHANTOM_OWNER_NAME. Optional. Falls back to the local-part of email. */
	name?: string;
	/** PHANTOM_OWNER_LINKEDIN_URL. Optional, future Phase 12 wizard plumbing. */
	linkedinUrl?: string;
}

/** Cap a single bullet at 280 chars. Mirrors a Tweet length so the intro
 * DM stays readable on mobile. The caller already ensures plain ASCII. */
export const MAX_BULLET_CHARS = 280;

/** Hard cap on total research time so the firstboot intro DM is not held
 * hostage by a slow site. The architect spec says ~15s. */
export const RESEARCH_BUDGET_MS = 15_000;

/** Per-fetch HTTP timeout. We make several fetches in parallel; each
 * gets its own AbortController so a single hang does not eat the budget. */
export const PER_FETCH_TIMEOUT_MS = 4_000;
