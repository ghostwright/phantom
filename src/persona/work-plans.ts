// Persona work plans: per-id catalog of pulls, signal patterns, draft
// kinds, voice, and required integrations consumed by the
// do_first_hour_of_work tool at firstboot.
//
// Architect: phantom-cloud-deploy/local/2026-05-03-slice-15-first-
// hour-of-work-architect.md (sections 1.4, 2, 6.1, 7).
//
// Canonical fixture: phantom-cloud-deploy/scripts/shared/persona-work-
// plans.json (slice 15d-fixture). This file is the in-VM phantom mirror
// and MUST stay byte-equal with the canonical for every persona_id and
// required_integrations array. The cross-repo drift CI guard at
// phantom-cloud-deploy/scripts/shared/verify-persona-work-plans.sh is
// the gate; it parses persona_id literals and required_integrations
// arrays out of this file and diff-checks against the canonical JSON.
//
// Editing this file requires lockstep updates in the canonical JSON
// and the two sibling mirrors (phantom-control Go, ghostwright-site
// dashboard TS), then a green verifier run.
//
// Voice contract: persona-voiced intro_line and footer_line are the
// fixed bookends every Block Kit DM renderer wraps around the LLM-
// generated summary. Cardinal rule: no em dashes, no emojis, no
// marketing voice.

export type PersonaWorkPlanSource =
	| "github"
	| "calendar"
	| "linear"
	| "slack-channel"
	| "slack-dm"
	| "hubspot"
	| "gmail"
	| "notion";

export interface PersonaWorkPlanPull {
	source: PersonaWorkPlanSource;
	query: string;
	required_grant: boolean;
	timeout_ms: number;
	max_rows: number;
}

export interface PersonaWorkPlan {
	persona_id: string;
	default_pulls: readonly PersonaWorkPlanPull[];
	signal_patterns: readonly string[];
	default_draft_kinds: readonly string[];
	max_drafts: number;
	intro_line: string;
	footer_line: string;
	ttd_target_seconds: number;
	ttd_hard_cap_seconds: number;
	expected_draft_count_min: number;
	expected_draft_count_max: number;
	required_integrations: readonly string[];
	fallback_dm_text: string;
}

export const WORK_PLANS = {
	"sdr-lilian": {
		persona_id: "sdr-lilian",
		default_pulls: [
			{
				source: "slack-dm",
				query: "messages in customer / prospect DMs older than 3 days with no reply from owner",
				required_grant: true,
				timeout_ms: 5000,
				max_rows: 20,
			},
			{
				source: "slack-channel",
				query:
					"messages in #leads or named-customer channels in the last 7 days where owner is mentioned and unreplied",
				required_grant: false,
				timeout_ms: 5000,
				max_rows: 20,
			},
			{
				source: "calendar",
				query: "meetings in the next 5 business days plus contacts attended in the last 14 days",
				required_grant: false,
				timeout_ms: 4000,
				max_rows: 30,
			},
		],
		signal_patterns: [
			"leads who replied but did not book a meeting",
			"calendar invites accepted with no follow-up scheduled",
		],
		default_draft_kinds: ["slack_reply", "email_reply"],
		max_drafts: 5,
		intro_line: "Lilian here.",
		footer_line: "Send / Edit / Skip each. I will hold off on the rest until you weigh in.",
		ttd_target_seconds: 30,
		ttd_hard_cap_seconds: 60,
		expected_draft_count_min: 2,
		expected_draft_count_max: 5,
		required_integrations: ["slack"],
		fallback_dm_text:
			"Lilian here. I am ready to start drafting outbound, but I need access to your CRM or your #leads channel to know who to write to. Connect HubSpot or grant me access to #leads at <link|the integrations panel> and I will have drafts ready in 30 seconds. Reply CONNECT and I will guide you.",
	},
	"eng-cos-marcus": {
		persona_id: "eng-cos-marcus",
		default_pulls: [
			{
				source: "github",
				query: "search/issues?q=is:open+review-requested:@me",
				required_grant: true,
				timeout_ms: 5000,
				max_rows: 25,
			},
			{
				source: "github",
				query: "issues?filter=mentioned&state=open&since=24h",
				required_grant: false,
				timeout_ms: 5000,
				max_rows: 25,
			},
			{
				source: "github",
				query: "search/issues?q=org:${owner_org}+state:open+label:p0+is:issue",
				required_grant: false,
				timeout_ms: 5000,
				max_rows: 10,
			},
			{
				source: "linear",
				query: "issues assigned to ${owner_email} OR labelled 'blocked' in active sprint",
				required_grant: false,
				timeout_ms: 5000,
				max_rows: 15,
			},
		],
		signal_patterns: [
			"PRs that have been blocking other people for >2 days",
			"CI failures on main in the last 6 hours",
			"P0 / blocker tickets in the active sprint",
		],
		default_draft_kinds: ["pr_comment", "standup_post", "slack_post"],
		max_drafts: 8,
		intro_line: "Marcus here.",
		footer_line: "Approve to ship the standup. Edit any PR comment before I send it.",
		ttd_target_seconds: 30,
		ttd_hard_cap_seconds: 60,
		expected_draft_count_min: 3,
		expected_draft_count_max: 8,
		required_integrations: ["github"],
		fallback_dm_text:
			"Marcus here. I am ready to triage your PRs, but I do not have GitHub access yet. Connect GitHub at <link|the integrations panel> and I will have today's standup plus PR triage drafted in 30 seconds.",
	},
	"am-sloane": {
		persona_id: "am-sloane",
		default_pulls: [
			{
				source: "slack-dm",
				query: "DMs from external (non-workspace) users in the last 14 days",
				required_grant: true,
				timeout_ms: 5000,
				max_rows: 30,
			},
			{
				source: "slack-channel",
				query: "messages in shared channels (org-name in channel name) in the last 14 days; flag escalation language",
				required_grant: false,
				timeout_ms: 5000,
				max_rows: 40,
			},
			{
				source: "calendar",
				query: "QBR / 1:1 invites in the next 14 days with non-workspace attendees",
				required_grant: false,
				timeout_ms: 4000,
				max_rows: 20,
			},
		],
		signal_patterns: [
			"accounts that have gone quiet (drop in message volume vs prior 14 days)",
			"messages containing escalation language ('cancel', 'unhappy', 'last straw')",
			"unanswered last-touch from a customer",
		],
		default_draft_kinds: ["check_in_message", "slack_reply"],
		max_drafts: 4,
		intro_line: "Sloane here.",
		footer_line: "Want me to send these today, or refine first? Send / Edit / Skip each.",
		ttd_target_seconds: 30,
		ttd_hard_cap_seconds: 60,
		expected_draft_count_min: 2,
		expected_draft_count_max: 4,
		required_integrations: ["slack"],
		fallback_dm_text:
			"Sloane here. To find churn signals I need access to your customer DMs and shared channels. I am authorized in your Slack but I cannot read external DMs without one more permission. Connect <link|here> and I will surface accounts at risk in 30 seconds.",
	},
	"bdr-theo": {
		persona_id: "bdr-theo",
		default_pulls: [
			{
				source: "slack-dm",
				query: "DM from owner with subject 'ICP names' or 'cold list' in the last 30 days",
				required_grant: true,
				timeout_ms: 5000,
				max_rows: 5,
			},
			{
				source: "github",
				query: "README + last 10 commits to ${owner_org}'s primary repo for value-prop calibration",
				required_grant: false,
				timeout_ms: 5000,
				max_rows: 10,
			},
		],
		signal_patterns: ["ICP names supplied by owner via DM", "value-prop sentences from README + commit messages"],
		default_draft_kinds: ["email_outbound"],
		max_drafts: 5,
		intro_line: "Theo here.",
		footer_line: "Send each / Edit each / Skip each. I will research more once you green-light the first.",
		ttd_target_seconds: 30,
		ttd_hard_cap_seconds: 60,
		expected_draft_count_min: 0,
		expected_draft_count_max: 5,
		required_integrations: ["slack"],
		fallback_dm_text:
			"Theo here. I will craft 5 personalized cold emails as soon as you send me 5 ICP names plus a one-liner about what you sell. Reply with the names + line and I will be back in 30 seconds with 5 emails ready to review.",
	},
	"sales-vp-priya": {
		persona_id: "sales-vp-priya",
		default_pulls: [
			{
				source: "calendar",
				query: "QBRs + AE 1:1s in the next 7 business days",
				required_grant: true,
				timeout_ms: 5000,
				max_rows: 20,
			},
			{
				source: "slack-channel",
				query: "messages in #pipeline or #revops in the last 7 days flagging deals",
				required_grant: false,
				timeout_ms: 5000,
				max_rows: 30,
			},
			{
				source: "slack-dm",
				query: "DMs from AE team members tagged with deal mentions",
				required_grant: false,
				timeout_ms: 5000,
				max_rows: 20,
			},
		],
		signal_patterns: [
			"deals mentioned multiple times this week without progression language",
			"AE 1:1s in the next 7 days where the AE has not reported deal progress",
		],
		default_draft_kinds: ["briefing_paragraph", "slack_post"],
		max_drafts: 4,
		intro_line: "Priya here.",
		footer_line: "Approve the board paragraph; Edit AE prep notes individually.",
		ttd_target_seconds: 30,
		ttd_hard_cap_seconds: 60,
		expected_draft_count_min: 1,
		expected_draft_count_max: 4,
		required_integrations: ["calendar"],
		fallback_dm_text:
			"Priya here. To watch pipeline I need Calendar (for QBRs and AE 1:1s) and ideally HubSpot. Connect Calendar at <link|the integrations panel> and I will have your weekly board paragraph ready in 30 seconds. CRM hookup will sharpen this once you connect.",
	},
	"gtm-eng-ryan": {
		persona_id: "gtm-eng-ryan",
		default_pulls: [
			{
				source: "github",
				query: "merged PRs in the last 7 days in landing-page or marketing-site repos",
				required_grant: true,
				timeout_ms: 5000,
				max_rows: 25,
			},
			{
				source: "slack-channel",
				query: "messages in #gtm or #marketing in the last 7 days flagging signup / funnel anomalies",
				required_grant: false,
				timeout_ms: 5000,
				max_rows: 30,
			},
			{
				source: "linear",
				query: "issues with label 'gtm' or 'marketing-site' in active sprint",
				required_grant: false,
				timeout_ms: 5000,
				max_rows: 15,
			},
		],
		signal_patterns: [
			"PRs that shipped a marketing-site change",
			"Slack messages flagging signup / funnel drops or integration breakage",
		],
		default_draft_kinds: ["slack_post", "experiment_writeup"],
		max_drafts: 4,
		intro_line: "Ryan here.",
		footer_line: "Approve the #gtm post; Edit the writeup before I share with engineering.",
		ttd_target_seconds: 30,
		ttd_hard_cap_seconds: 60,
		expected_draft_count_min: 1,
		expected_draft_count_max: 4,
		required_integrations: ["github"],
		fallback_dm_text:
			"Ryan here. To watch GTM I need GitHub (for marketing-site PRs and integration health). Connect GitHub at <link|the integrations panel> and I will have a #gtm summary plus the experiment writeup in 30 seconds.",
	},
	"founder-asst-adrian": {
		persona_id: "founder-asst-adrian",
		default_pulls: [
			{
				source: "slack-dm",
				query: "owner's DMs in the last 7 days flagged as needing reply",
				required_grant: true,
				timeout_ms: 5000,
				max_rows: 30,
			},
			{
				source: "calendar",
				query: "meetings in the next 3 business days where prep is missing",
				required_grant: false,
				timeout_ms: 4000,
				max_rows: 15,
			},
			{
				source: "github",
				query: "high-level: org PRs labelled 'blocker' or PRs from ${owner_email} needing review",
				required_grant: false,
				timeout_ms: 5000,
				max_rows: 15,
			},
			{
				source: "linear",
				query: "active sprint summary: blockers + at-risk issues",
				required_grant: false,
				timeout_ms: 5000,
				max_rows: 15,
			},
		],
		signal_patterns: [
			"team DMs that are draft-able (a yes/no question, a small ask)",
			"customer escalations Adrian recognizes by tone",
			"calendar prep missing for meetings within 3 business days",
			"board-prep deadlines",
		],
		default_draft_kinds: ["slack_reply", "briefing_paragraph"],
		max_drafts: 6,
		intro_line: "Adrian here.",
		footer_line: "Reply EDIT <id> to tweak. Reply SKIP ALL to stop today.",
		ttd_target_seconds: 30,
		ttd_hard_cap_seconds: 60,
		expected_draft_count_min: 3,
		expected_draft_count_max: 6,
		required_integrations: ["slack"],
		fallback_dm_text:
			"Adrian here. To know what needs you I need Slack DMs (yours), Calendar, GitHub, Linear. Slack is connected; the rest are not yet. Connect any of them at <link|the integrations panel> and I will start surfacing what needs you immediately. The more you connect, the better I get.",
	},
} as const satisfies Record<string, PersonaWorkPlan>;

export type WorkPlanPersonaId = keyof typeof WORK_PLANS;

// PERSONA_WORK_PLAN_IDS: canonical ordering, locked by the cross-repo
// verifier and by phantom-cloud-deploy/scripts/shared/personas.json
// (slice 16d).
export const PERSONA_WORK_PLAN_IDS: readonly WorkPlanPersonaId[] = [
	"sdr-lilian",
	"eng-cos-marcus",
	"am-sloane",
	"bdr-theo",
	"sales-vp-priya",
	"gtm-eng-ryan",
	"founder-asst-adrian",
] as const;

// getPersonaWorkPlan: typed lookup. Returns undefined for unknown ids
// (the runner reads PHANTOM_PERSONA_ID directly, and an unknown id
// surfaces the persona_unknown reason code in the audit trail).
export function getPersonaWorkPlan(id: string | undefined): PersonaWorkPlan | undefined {
	if (!id) return undefined;
	const trimmed = id.trim();
	if (!trimmed) return undefined;
	return (WORK_PLANS as Record<string, PersonaWorkPlan>)[trimmed];
}

// filterIntegrationsByGrants returns the intersection of the persona's
// required_integrations and the available_integrations passed in. The
// runner uses this to gate STEP 1: if the intersection is empty AND
// the persona has any required integrations declared, the run jumps
// to the no_integrations_granted DM (architect §6.1). Slack is always
// granted by definition (wizard slot 10 firstboot install) so the
// most common empty-intersection case is a tier-2 grant the user has
// not yet connected (HubSpot for Lilian, GitHub for Marcus, etc.).
export function filterIntegrationsByGrants(required: readonly string[], available: readonly string[]): string[] {
	const have = new Set(available.map((s) => s.toLowerCase()));
	return required.filter((r) => have.has(r.toLowerCase()));
}
