// Block Kit renderer for the do_first_hour_of_work DM (architect §5).
//
// Shape: 1 header + 1 markdown summary + N draft sections (each with 3
// buttons send/edit/skip per architect §5.1) + 1 skip-all action row +
// 1 context footer. Action_id pattern phantom:draft:{draft_id}:{action}
// where action is send|edit|skip|skip_all|save_only.
//
// The renderer accepts the persona work plan (for intro_line +
// footer_line) and an array of drafts. Pull-summary is a small
// pre-formatted string ("I pulled X messages and Y deals; drafted Z
// items.") composed by the runner.
//
// Voice contract: persona-fixed intro_line and footer_line bookend the
// LLM-generated summary. No em dashes, no emojis, no marketing voice.

import type { DraftKind } from "../../persona/types.ts";
import type { PersonaWorkPlan } from "../../persona/work-plans.ts";
import type { SlackBlock } from "../feedback.ts";

export interface FirstHourDmDraft {
	draft_id: string;
	kind: DraftKind;
	summary: string;
	body_preview: string;
	reference_url?: string;
}

export interface FirstHourDmRenderInput {
	persona: PersonaWorkPlan;
	drafts: readonly FirstHourDmDraft[];
	pull_summary: string;
	duration_seconds: number;
	dashboard_url?: string;
	agent_id?: string;
	// partial: when true (60s cap or llm_error_mid_flow degraded path),
	// the section block prepends a "I was still working when I had to
	// send this; reply MORE for the rest" affordance per architect §6.6.
	partial?: boolean;
}

export interface FirstHourDmFallbackInput {
	persona: PersonaWorkPlan;
	// fallback DM: when no drafts produced (no_integrations_granted,
	// all_pulls_zero_data, zero_drafts_from_nonzero_data,
	// integration_auth_expired). Body is the verbatim DM text from
	// architect §6.1-§6.5.
	body: string;
	dashboard_url?: string;
}

const SKIP_ALL_BLOCK_ID = "phantom_first_hour_skip_all";

export function renderFirstHourDmBlocks(input: FirstHourDmRenderInput): SlackBlock[] {
	const { persona, drafts, pull_summary, duration_seconds, dashboard_url, agent_id, partial } = input;
	const blocks: SlackBlock[] = [];

	blocks.push({
		type: "header",
		text: { type: "plain_text", text: persona.intro_line, emoji: false } as { type: string; text: string },
	} as SlackBlock);

	const opener = partial
		? `_I was still working when I had to send this; reply MORE for the rest._\n\n*First hour summary*\n${pull_summary}\n_Took ${duration_seconds} seconds._`
		: `*First hour summary*\n${pull_summary}\n_Took ${duration_seconds} seconds._`;

	blocks.push({
		type: "section",
		text: { type: "mrkdwn", text: opener },
	} as SlackBlock);

	blocks.push({ type: "divider" } as SlackBlock);

	drafts.forEach((draft, index) => {
		const summary = `*Draft ${index + 1} of ${drafts.length}* | ${draft.summary}\n_${truncate(draft.body_preview, 320)}_`;
		const summaryWithLink = draft.reference_url ? `${summary}\n\n<${draft.reference_url}|Source>` : summary;
		blocks.push({
			type: "section",
			text: { type: "mrkdwn", text: summaryWithLink },
		} as SlackBlock);
		blocks.push({
			type: "actions",
			block_id: `draft_${draft.draft_id}`,
			elements: [
				{
					type: "button",
					action_id: `phantom:draft:${draft.draft_id}:send`,
					style: "primary",
					text: { type: "plain_text", text: "Send", emoji: false },
					value: draft.draft_id,
				},
				{
					type: "button",
					action_id: `phantom:draft:${draft.draft_id}:edit`,
					text: { type: "plain_text", text: "Edit", emoji: false },
					value: draft.draft_id,
				},
				{
					type: "button",
					action_id: `phantom:draft:${draft.draft_id}:skip`,
					text: { type: "plain_text", text: "Skip", emoji: false },
					value: draft.draft_id,
				},
			],
		} as SlackBlock);
		blocks.push({ type: "divider" } as SlackBlock);
	});

	blocks.push({
		type: "actions",
		block_id: SKIP_ALL_BLOCK_ID,
		elements: [
			{
				type: "button",
				action_id: "phantom:draft:all:skip_all",
				style: "danger",
				text: { type: "plain_text", text: "Skip all today", emoji: false },
				value: "all",
				confirm: {
					title: { type: "plain_text", text: `Skip all ${drafts.length} drafts?` },
					text: {
						type: "mrkdwn",
						text: "I will hold off until you ping me. Reply MORE if you want me to surface them again.",
					},
					confirm: { type: "plain_text", text: "Skip all" },
					deny: { type: "plain_text", text: "Cancel" },
				},
			},
		],
	} as SlackBlock);

	const dashLink = dashboard_url && agent_id ? ` <${dashboard_url}/agents/${agent_id}|See all in dashboard>.` : "";
	blocks.push({
		type: "context",
		elements: [
			{
				type: "mrkdwn",
				text: `${persona.footer_line}${dashLink}`,
			},
		],
	} as SlackBlock);

	return blocks;
}

// renderFirstHourDmFallbackBlocks: zero-draft variants. Used by all five
// failure modes that produce no drafts (no_integrations_granted,
// all_pulls_zero_data, zero_drafts_from_nonzero_data,
// integration_auth_expired, slack_post_failed pre-Slack). The body is
// the verbatim per-persona DM text the architect specifies.
export function renderFirstHourDmFallbackBlocks(input: FirstHourDmFallbackInput): SlackBlock[] {
	const { persona, body, dashboard_url } = input;
	const blocks: SlackBlock[] = [
		{
			type: "header",
			text: { type: "plain_text", text: persona.intro_line, emoji: false } as { type: string; text: string },
		} as SlackBlock,
		{
			type: "section",
			text: { type: "mrkdwn", text: body },
		} as SlackBlock,
	];
	if (dashboard_url) {
		blocks.push({
			type: "context",
			elements: [{ type: "mrkdwn", text: `<${dashboard_url}|Open the dashboard>` }],
		} as SlackBlock);
	}
	return blocks;
}

// renderFirstHourDmFallbackText: the chat.postMessage `text` field for
// clients that do not render Block Kit (mobile push, screen readers,
// the Slack search index). Plain text only.
export function renderFirstHourDmFallbackText(persona: PersonaWorkPlan, draftCount: number): string {
	if (draftCount <= 0) {
		return `${persona.intro_line} ${persona.fallback_dm_text}`;
	}
	const tail = draftCount === 1 ? "1 item" : `${draftCount} items`;
	return `${persona.intro_line} I drafted ${tail} for you. ${persona.footer_line}`;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, Math.max(0, max - 3))}...`;
}
