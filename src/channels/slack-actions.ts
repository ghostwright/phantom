/**
 * Slack interactive action handlers: feedback buttons, agent-suggested
 * actions, and the morning-brief confirmation buttons emitted by the
 * synthetic introduction DM. Registers Bolt action handlers that route
 * button clicks to the appropriate subsystems (feedback -> evolution,
 * actions -> agent follow-up, morning-brief -> preference recorder).
 */

import type { App } from "@slack/bolt";
import { FEEDBACK_ACTION_IDS, buildFeedbackAckBlocks, emitFeedback, parseFeedbackAction } from "./feedback.ts";
import {
	MORNING_BRIEF_LOCK_ACTION_ID,
	MORNING_BRIEF_RETIME_ACTION_ID,
	MORNING_BRIEF_SKIP_ACTION_ID,
} from "./slack-introduction.ts";

type ActionFollowUpHandler = (params: {
	userId: string;
	channel: string;
	threadTs: string;
	actionLabel: string;
	actionPayload?: string;
	conversationId: string;
}) => Promise<void>;

let actionFollowUpHandler: ActionFollowUpHandler | null = null;

export function setActionFollowUpHandler(handler: ActionFollowUpHandler): void {
	actionFollowUpHandler = handler;
}

/**
 * Morning-brief preference recorder. Three states: lock the default 8am
 * slot, retime (the user wants a different hour and will reply with it),
 * skip mornings entirely. Slice 15 wires the SQLite table that backs
 * `MorningBriefPreference`; until then the recorder defaults to a
 * structured log line so the choice is visible in production logs and
 * the wire shape is locked.
 */
export type MorningBriefChoice = "lock_8am" | "retime" | "skip";

export type MorningBriefPreferenceRecorder = (params: {
	userId: string;
	channel: string;
	choice: MorningBriefChoice;
	clickedAt: number;
}) => Promise<void> | void;

let morningBriefRecorder: MorningBriefPreferenceRecorder | null = null;

export function setMorningBriefPreferenceRecorder(recorder: MorningBriefPreferenceRecorder): void {
	morningBriefRecorder = recorder;
}

/**
 * First-hour-of-work draft action handler (architect §5.4). The user
 * clicks Send / Edit / Skip / Skip-All / Save-Only on the Block Kit
 * DM that the runner posted at firstboot; the Bolt action handler
 * parses the action_id (phantom:draft:{draft_id}:{action}), looks up
 * the draft via this recorder, and the recorder updates the local
 * SQLite row + (slice 15b) POSTs to phantom-control.
 */
export type FirstHourDraftAction = "send" | "edit" | "skip" | "skip_all" | "save_only";

export type FirstHourDraftActionRecorder = (params: {
	draftId: string;
	action: FirstHourDraftAction;
	userId: string;
	channelId: string;
	messageTs: string;
	clickedAt: number;
}) => Promise<void> | void;

let firstHourDraftRecorder: FirstHourDraftActionRecorder | null = null;

export function setFirstHourDraftActionRecorder(recorder: FirstHourDraftActionRecorder): void {
	firstHourDraftRecorder = recorder;
}

/** Extract a typed value from the Bolt body object */
function bodyField<T>(body: unknown, ...keys: string[]): T | undefined {
	let obj = body as Record<string, unknown> | undefined;
	for (const key of keys) {
		if (!obj || typeof obj !== "object") return undefined;
		obj = obj[key] as Record<string, unknown> | undefined;
	}
	return obj as unknown as T | undefined;
}

export function registerSlackActions(app: App): void {
	// Register feedback button handlers
	for (const actionId of FEEDBACK_ACTION_IDS) {
		app.action(actionId, async ({ ack, body, client }) => {
			await ack();

			const b = body as unknown as Record<string, unknown>;
			const actions = b.actions as Array<{ action_id: string; value?: string }> | undefined;
			if (!actions?.[0]) return;

			const feedbackType = parseFeedbackAction(actions[0].action_id);
			if (!feedbackType) return;

			const channelId = bodyField<string>(b, "channel", "id");
			const messageTs = bodyField<string>(b, "message", "ts");
			const userId = bodyField<string>(b, "user", "id");
			const threadTs = bodyField<string>(b, "message", "thread_ts") ?? messageTs;
			const messageText = bodyField<string>(b, "message", "text") ?? "";
			const existingBlocks = bodyField<Array<{ type: string; block_id?: string }>>(b, "message", "blocks") ?? [];

			if (!channelId || !messageTs || !userId) return;

			emitFeedback({
				type: feedbackType,
				conversationId: `slack:${channelId}:${threadTs}`,
				messageTs,
				userId,
				source: "button",
				timestamp: Date.now(),
			});

			// Replace feedback buttons with acknowledgment
			const nonFeedbackBlocks = existingBlocks.filter((block) => {
				return !block.block_id?.startsWith("phantom_feedback_");
			});
			// Remove trailing divider
			const cleaned = nonFeedbackBlocks.filter((block, i) => {
				if (block.type === "divider" && i === nonFeedbackBlocks.length - 1) return false;
				return true;
			});

			const ackBlocks = buildFeedbackAckBlocks(feedbackType);

			try {
				await client.chat.update({
					channel: channelId,
					ts: messageTs,
					text: messageText,
					blocks: [...cleaned, ...ackBlocks],
				} as unknown as Parameters<typeof client.chat.update>[0]);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[slack] Failed to update feedback buttons: ${msg}`);
			}
		});
	}

	// Register agent action button handler
	app.action(/^phantom:action:\d+$/, async ({ ack, body, client }) => {
		await ack();

		const b = body as unknown as Record<string, unknown>;
		const actions = b.actions as Array<{ action_id: string; value?: string }> | undefined;
		if (!actions?.[0]) return;

		const value = actions[0].value ?? "";
		const channelId = bodyField<string>(b, "channel", "id");
		const messageTs = bodyField<string>(b, "message", "ts");
		const userId = bodyField<string>(b, "user", "id");
		const threadTs = bodyField<string>(b, "message", "thread_ts") ?? messageTs;
		const messageText = bodyField<string>(b, "message", "text") ?? "";
		const existingBlocks = bodyField<Array<{ type: string; block_id?: string }>>(b, "message", "blocks") ?? [];

		if (!channelId || !messageTs || !userId) return;

		let label = "action";
		let payload: string | undefined;
		try {
			const parsed = JSON.parse(value);
			label = parsed.label ?? label;
			payload = parsed.payload;
		} catch {
			label = value;
		}

		// Replace action buttons with a note showing what was clicked
		const nonActionBlocks = existingBlocks.filter((block) => {
			return block.block_id !== "phantom_actions";
		});

		try {
			await client.chat.update({
				channel: channelId,
				ts: messageTs,
				text: messageText,
				blocks: [
					...nonActionBlocks,
					{
						type: "context",
						elements: [{ type: "mrkdwn", text: `_<@${userId}> clicked: ${label}_` }],
					},
				],
			} as unknown as Parameters<typeof client.chat.update>[0]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[slack] Failed to update action buttons: ${msg}`);
		}

		// Route to agent as follow-up
		if (actionFollowUpHandler) {
			await actionFollowUpHandler({
				userId,
				channel: channelId,
				threadTs: threadTs ?? messageTs,
				actionLabel: label,
				actionPayload: payload,
				conversationId: `slack:${channelId}:${threadTs}`,
			});
		}
	});

	// Morning-brief confirmation handlers. Each registered separately so
	// Bolt can route the click without our own switch-on-action_id; the
	// shared body lifts the click target, swaps the actions block for a
	// confirmation context block, and forwards to the preference
	// recorder. The brief itself does not run yet (slice 15); this PR
	// captures the choice so the brief lands with the user's
	// already-recorded preference on day one.
	for (const meta of [
		{ id: MORNING_BRIEF_LOCK_ACTION_ID, choice: "lock_8am" as const, ack: "Locked. Tomorrow at 8am your time." },
		{
			id: MORNING_BRIEF_RETIME_ACTION_ID,
			choice: "retime" as const,
			ack: "Got it. Reply with the time you want, like '7am' or '9:30am', and I'll match it.",
		},
		{
			id: MORNING_BRIEF_SKIP_ACTION_ID,
			choice: "skip" as const,
			ack: "No morning brief. I'll wait for you to ping me.",
		},
	]) {
		app.action(meta.id, async ({ ack, body, client }) => {
			await ack();

			const b = body as unknown as Record<string, unknown>;
			const channelId = bodyField<string>(b, "channel", "id");
			const messageTs = bodyField<string>(b, "message", "ts");
			const userId = bodyField<string>(b, "user", "id");
			const messageText = bodyField<string>(b, "message", "text") ?? "";
			const existingBlocks = bodyField<Array<{ type: string; block_id?: string }>>(b, "message", "blocks") ?? [];

			if (!channelId || !messageTs || !userId) return;

			// Swap the actions row for a context block recording the
			// click. Mirrors the existing phantom:action handler shape so
			// the user gets the same "click landed" feeling across every
			// button surface in the product.
			const filtered = existingBlocks.filter((block) => block.block_id !== "phantom_morning_brief");
			try {
				await client.chat.update({
					channel: channelId,
					ts: messageTs,
					text: messageText,
					blocks: [
						...filtered,
						{
							type: "context",
							elements: [{ type: "mrkdwn", text: `_${meta.ack}_` }],
						},
					],
				} as unknown as Parameters<typeof client.chat.update>[0]);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[slack] Failed to update morning-brief buttons: ${msg}`);
			}

			if (morningBriefRecorder) {
				try {
					await morningBriefRecorder({ userId, channel: channelId, choice: meta.choice, clickedAt: Date.now() });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.warn(`[slack] morning-brief recorder failed: ${msg}`);
				}
			} else {
				// Until slice 15 wires the persistent recorder, surface the
				// choice in logs so operators can confirm the wire shape
				// end-to-end against production traffic.
				console.log(
					`[slack] morning_brief_choice user=${userId} channel=${channelId} choice=${meta.choice} ts=${messageTs}`,
				);
			}
		});
	}

	// Slice 15a first-hour-of-work draft buttons. Pattern:
	// phantom:draft:{draft_id}:{action} where action is send | edit |
	// skip | skip_all | save_only. The handler parses the action_id,
	// hands off to the draft recorder (slice 15a wires the local
	// SQLite update; slice 15b POSTs to phantom-control).
	app.action(/^phantom:draft:[^:]+:(send|edit|skip|skip_all|save_only)$/, async ({ ack, body, client }) => {
		await ack();

		const b = body as unknown as Record<string, unknown>;
		const actions = b.actions as Array<{ action_id: string; value?: string }> | undefined;
		if (!actions?.[0]) return;

		const actionId = actions[0].action_id;
		const parts = actionId.split(":");
		if (parts.length !== 4) return;
		const draftId = parts[2];
		const action = parts[3] as FirstHourDraftAction;

		const channelId = bodyField<string>(b, "channel", "id");
		const messageTs = bodyField<string>(b, "message", "ts");
		const userId = bodyField<string>(b, "user", "id");
		if (!channelId || !messageTs || !userId) return;

		if (firstHourDraftRecorder) {
			try {
				await firstHourDraftRecorder({
					draftId,
					action,
					userId,
					channelId,
					messageTs,
					clickedAt: Date.now(),
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[slack] first-hour draft recorder failed: ${msg}`);
			}
		} else {
			console.log(`[slack] first_hour_draft_action draft=${draftId} action=${action} user=${userId}`);
		}

		// Update the message: replace the draft's own actions block with a
		// context block reflecting the click. The skip-all and save_only
		// surfaces follow the same shape; the send/edit/skip variants
		// flip just the per-draft actions row, leaving other drafts in the
		// same DM untouched.
		const existingBlocks = bodyField<Array<{ type: string; block_id?: string }>>(b, "message", "blocks") ?? [];
		const replacementText = ackTextForAction(action, draftId);
		const targetBlockId = action === "skip_all" ? "phantom_first_hour_skip_all" : `draft_${draftId}`;
		const updatedBlocks = existingBlocks.map((block) => {
			if (block.block_id !== targetBlockId) return block;
			return {
				type: "context",
				elements: [{ type: "mrkdwn", text: replacementText }],
			};
		});
		const messageText = bodyField<string>(b, "message", "text") ?? "";
		try {
			await client.chat.update({
				channel: channelId,
				ts: messageTs,
				text: messageText,
				blocks: updatedBlocks,
			} as unknown as Parameters<typeof client.chat.update>[0]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[slack] Failed to update first-hour draft buttons: ${msg}`);
		}
	});
}

function ackTextForAction(action: FirstHourDraftAction, draftId: string): string {
	switch (action) {
		case "send":
			return `_Sent. (draft ${draftId})_`;
		case "edit":
			return `_Edit modal opened. (draft ${draftId})_`;
		case "skip":
			return `_Skipped. (draft ${draftId})_`;
		case "skip_all":
			return "_All drafts skipped. Reply MORE to surface them again._";
		case "save_only":
			return `_Saved. (draft ${draftId})_`;
	}
}
