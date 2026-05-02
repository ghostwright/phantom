// Per-persona DM text for the six failure modes (architect §6).
//
// Each function returns the verbatim DM body the architect doc
// specifies. The body is the section block's mrkdwn text the
// renderFirstHourDmFallbackBlocks helper consumes; the body is also
// the chat.postMessage `text` fallback for clients that do not render
// blocks.
//
// Locked taxonomy (architect §7.2) of 11 reason codes; six failure
// modes here plus the success path (`ok`), the
// fire_already_completed silent skip, the persona_unknown operator
// alert, and the internal_error catch-all.
//
// Voice contract: persona-voiced. No em dashes, no emojis.

import type { ReasonCode } from "./types.ts";
import { type PersonaWorkPlan, getPersonaWorkPlan } from "./work-plans.ts";

// no_integrations_granted: the verbatim DM text comes from the
// fallback_dm_text field on the work plan (canonical fixture). The
// architect doc §6.1 carries the same text per persona.
export function noIntegrationsGrantedDm(persona: PersonaWorkPlan): string {
	return persona.fallback_dm_text;
}

// all_pulls_zero_data: pulls succeeded but every source returned 0
// rows. Architect §6.2 per-persona DM text.
export function allPullsZeroDataDm(persona: PersonaWorkPlan): string {
	const text = ZERO_DATA_DM[persona.persona_id];
	if (!text) {
		return `${persona.intro_line} I checked your data and everything looks current. I will watch and ping you when something needs you. Want me to set a daily check at 8am?`;
	}
	return text;
}

// llm_error_mid_flow: the LLM call errored. Architect §6.3 specifies a
// shared degraded-path body for ALL personas.
export function llmErrorMidFlowDm(persona: PersonaWorkPlan, draftsSavedSoFar: number): string {
	if (draftsSavedSoFar <= 0) {
		return `${persona.intro_line} I ran into an issue starting your first hour. Reply RETRY and I will try again.`;
	}
	const items = draftsSavedSoFar === 1 ? "1 item" : `${draftsSavedSoFar} items`;
	return `${persona.intro_line} I drafted ${items} before running into an issue. Here is what I have so far. Reply RETRY and I will pick up where I left off.`;
}

// zero_drafts_from_nonzero_data: the LLM ran but produced 0 drafts
// because nothing matched the persona's signal patterns. Architect §6.4
// per-persona DM text.
export function zeroDraftsFromNonzeroDataDm(persona: PersonaWorkPlan): string {
	const text = ZERO_DRAFTS_DM[persona.persona_id];
	if (!text) {
		return `${persona.intro_line} I read your data; nothing matches the patterns I draft for. I will watch for new activity. Want me to set a daily check at 8am?`;
	}
	return text;
}

// integration_auth_expired: a pull returned 401/410. Architect §6.5
// per-persona reconnect-prompt DM text.
export function integrationAuthExpiredDm(persona: PersonaWorkPlan, expired_provider: string): string {
	const provider = capitalize(expired_provider);
	const text = AUTH_EXPIRED_DM_TEMPLATE[persona.persona_id];
	if (text) {
		return text(provider);
	}
	return `${persona.intro_line} ${provider} auth has expired. Reconnect at <link|the integrations panel> and I will pick up where I left off.`;
}

// sixty_second_cap_hit: wall-clock cap fired. Architect §6.6 specifies a
// shared partial-DM body for ALL personas.
export function sixtySecondCapHitDm(persona: PersonaWorkPlan, draftsSavedSoFar: number): string {
	const items = draftsSavedSoFar === 1 ? "1 item" : `${draftsSavedSoFar} items`;
	return `${persona.intro_line} I drafted ${items} in your first 60 seconds. There may be more I did not get to. Reply MORE and I will pick up where I left off.`;
}

// failureModeForReason: dispatch helper used by the runner to pick the
// right DM body for a given reason code. The runner constructs its own
// fallback inputs (persona, drafts saved, expired provider) and feeds
// them in; this dispatcher centralizes the wiring so the test suite
// pins each branch.
export interface FailureModeContext {
	persona: PersonaWorkPlan;
	drafts_saved_so_far: number;
	expired_provider?: string;
}

export function dmTextForReason(reason: ReasonCode, ctx: FailureModeContext): string | null {
	switch (reason) {
		case "no_integrations_granted":
			return noIntegrationsGrantedDm(ctx.persona);
		case "all_pulls_zero_data":
			return allPullsZeroDataDm(ctx.persona);
		case "llm_error_mid_flow":
			return llmErrorMidFlowDm(ctx.persona, ctx.drafts_saved_so_far);
		case "zero_drafts_from_nonzero_data":
			return zeroDraftsFromNonzeroDataDm(ctx.persona);
		case "integration_auth_expired":
			return integrationAuthExpiredDm(ctx.persona, ctx.expired_provider ?? "the integration");
		case "sixty_second_cap_hit":
			return sixtySecondCapHitDm(ctx.persona, ctx.drafts_saved_so_far);
		default:
			return null;
	}
}

// Verbatim DM text per architect §6.2 (all_pulls_zero_data).
const ZERO_DATA_DM: Record<string, string> = {
	"sdr-lilian":
		"Lilian here. I checked your DMs and the #leads channel; everything is current. I will watch for new activity and ping you when something needs you. Want me to set a daily check at 8am?",
	"eng-cos-marcus":
		"Marcus here. PRs and CI all green. Linear active sprint is on track. I will watch for new activity and ping you when something needs you. Want me to set a daily check at 8am?",
	"am-sloane":
		"Sloane here. I checked your last 14 days of customer threads; everything looks current and quiet in a good way. I will watch and ping you if accounts shift. Daily check at 8am?",
	"bdr-theo":
		"Theo here. I do not see ICP names in your DM history yet. Send me 5 names plus a one-line value-prop and I will come back with 5 personalized cold emails in 30 seconds.",
	"sales-vp-priya":
		"Priya here. Calendar and #pipeline are clean for this week. I will watch and surface anomalies. Daily check at 8am?",
	"gtm-eng-ryan":
		"Ryan here. No new merges in marketing-site or integration-health PRs in the last 7 days. Funnel anomalies absent. I will watch and ping you. Daily check at 8am?",
	"founder-asst-adrian":
		"Adrian here. Your morning is clean. Nothing in DMs, calendar prep, or sprint blockers needs you right now. I will watch and surface anything urgent. Daily check at 8am?",
};

// Verbatim DM text per architect §6.4 (zero_drafts_from_nonzero_data).
const ZERO_DRAFTS_DM: Record<string, string> = {
	"sdr-lilian":
		"Lilian here. I read 12 messages in your DMs and looked at 8 invites. Nothing matches the patterns I draft for (no leads stalled past 3 days, no accepted invites without follow-up). I will watch for new activity. Want me to set a daily check at 8am?",
	"eng-cos-marcus":
		"Marcus here. I scanned 12 open PRs and 4 issues. None are blocking other people for more than 2 days, no CI failures on main, no P0 tickets in active sprint. Looks like a clean week. Daily check at 8am?",
	"am-sloane":
		"Sloane here. I read 30 customer DMs and shared-channel messages. No accounts have gone quiet, no escalation language, all last-touches are within 3 days. Looks healthy. I will watch and ping you. Daily check at 8am?",
	"bdr-theo":
		"Theo here. I see 3 ICP names in your DMs but they are all from 6 months ago and stale. Send me 5 fresh names and a one-line value-prop and I will draft 5 emails in 30 seconds.",
	"sales-vp-priya":
		"Priya here. I scanned QBRs and #pipeline. Nothing flags as at-risk this week. AEs are on track. Want me to draft a positive board paragraph anyway, or wait for more data? Reply DRAFT or WAIT.",
	"gtm-eng-ryan":
		"Ryan here. I read 25 PRs and #gtm. Nothing flags as a regression or experiment-conclusion this week. I will watch and surface anomalies. Daily check at 8am?",
	"founder-asst-adrian":
		"Adrian here. I scanned 30 DMs, calendar, GitHub, Linear. Nothing flags as needing you today. Looks like a clean morning. I will watch and ping you if anything shifts. Daily check at 8am?",
};

// Verbatim DM text per architect §6.5 (integration_auth_expired). The
// architect doc names Lilian + Marcus explicitly; the other five take
// the same shape, persona-voiced and provider-templated.
const AUTH_EXPIRED_DM_TEMPLATE: Record<string, (provider: string) => string> = {
	"sdr-lilian": (p) =>
		`Lilian here. I tried to read ${p} and got an auth error; looks like the integration was revoked. Reconnect ${p} at <link|the integrations panel> and I will draft your outbound queue.`,
	"eng-cos-marcus": (p) =>
		`Marcus here. ${p} auth has expired. Reconnect at <link|the integrations panel> and I will triage your PRs in 30 seconds.`,
	"am-sloane": (p) =>
		`Sloane here. ${p} auth has expired. Reconnect at <link|the integrations panel> and I will surface accounts at risk.`,
	"bdr-theo": (p) =>
		`Theo here. ${p} auth has expired. Reconnect at <link|the integrations panel> and I will pick up the prospect research.`,
	"sales-vp-priya": (p) =>
		`Priya here. ${p} auth has expired. Reconnect at <link|the integrations panel> and I will read pipeline again.`,
	"gtm-eng-ryan": (p) =>
		`Ryan here. ${p} auth has expired. Reconnect at <link|the integrations panel> and I will pick up the funnel watch.`,
	"founder-asst-adrian": (p) =>
		`Adrian here. ${p} auth has expired. Reconnect at <link|the integrations panel> and I will keep your morning brief sharp.`,
};

function capitalize(s: string): string {
	if (!s) return s;
	return s[0].toUpperCase() + s.slice(1);
}

// resolveOrThrowPersona: helper used by tests that drive the failure
// pickers off persona_id strings. Throws on unknown id.
export function resolveOrThrowPersona(personaId: string): PersonaWorkPlan {
	const plan = getPersonaWorkPlan(personaId);
	if (!plan) throw new Error(`unknown persona_id: ${personaId}`);
	return plan;
}
