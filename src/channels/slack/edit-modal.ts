// views.open payload for the do_first_hour_of_work draft edit modal
// (architect §5.3). Triggered when the user clicks the Edit button on
// a draft section in the first-hour DM. The modal carries the draft's
// current body in a multiline plain_text_input; submit saves the
// edited body and triggers a send (status pending -> sent), the
// in-line "Save without sending" button saves and leaves status as
// pending (status pending -> edited).
//
// callback_id is phantom_draft_edit_modal so the Bolt view-submission
// handler can route by callback_id. private_metadata carries the
// draft_id so the handler can look up the draft on submit without
// re-parsing the action_id from a button click.

import type { DraftKind } from "../../persona/types.ts";

export interface EditModalInput {
	draft_id: string;
	draft_kind: DraftKind;
	current_body: string;
	edit_hints?: string;
	persona_intro_line: string;
}

export interface SlackView {
	type: "modal";
	callback_id: string;
	private_metadata: string;
	title: { type: "plain_text"; text: string; emoji: false };
	submit: { type: "plain_text"; text: string; emoji: false };
	close: { type: "plain_text"; text: string; emoji: false };
	blocks: Array<Record<string, unknown>>;
}

export const EDIT_MODAL_CALLBACK_ID = "phantom_draft_edit_modal";
export const DRAFT_BODY_BLOCK_ID = "draft_body_block";
export const DRAFT_BODY_INPUT_ACTION_ID = "draft_body_input";

export function buildEditModalView(input: EditModalInput): SlackView {
	const hints = input.edit_hints
		? `*Draft kind:* ${humanizeKind(input.draft_kind)}\n*Edit hints from ${input.persona_intro_line.replace(/\.$/, "")}:* ${input.edit_hints}`
		: `*Draft kind:* ${humanizeKind(input.draft_kind)}`;

	return {
		type: "modal",
		callback_id: EDIT_MODAL_CALLBACK_ID,
		private_metadata: input.draft_id,
		title: { type: "plain_text", text: "Edit draft", emoji: false },
		submit: { type: "plain_text", text: "Save and send", emoji: false },
		close: { type: "plain_text", text: "Cancel", emoji: false },
		blocks: [
			{
				type: "section",
				text: { type: "mrkdwn", text: hints },
			},
			{
				type: "input",
				block_id: DRAFT_BODY_BLOCK_ID,
				label: { type: "plain_text", text: "Draft body", emoji: false },
				element: {
					type: "plain_text_input",
					action_id: DRAFT_BODY_INPUT_ACTION_ID,
					multiline: true,
					initial_value: input.current_body,
					max_length: 4000,
				},
			},
			{
				type: "actions",
				block_id: "edit_save_only",
				elements: [
					{
						type: "button",
						action_id: `phantom:draft:${input.draft_id}:save_only`,
						text: { type: "plain_text", text: "Save without sending", emoji: false },
						value: input.draft_id,
					},
				],
			},
		],
	};
}

const HUMAN_KIND_LABELS: Record<DraftKind, string> = {
	email_reply: "Reply",
	email_outbound: "Outbound email",
	pr_comment: "PR comment",
	pr_review_request: "PR review request",
	slack_reply: "Slack reply",
	slack_post: "Slack post",
	standup_post: "Standup post",
	check_in_message: "Check-in message",
	experiment_writeup: "Experiment writeup",
	briefing_paragraph: "Briefing paragraph",
	calendar_invite: "Calendar invite",
};

function humanizeKind(kind: DraftKind): string {
	return HUMAN_KIND_LABELS[kind] ?? kind;
}
